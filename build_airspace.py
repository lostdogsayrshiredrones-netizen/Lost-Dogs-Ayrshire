#!/usr/bin/env python3
"""
Builds airspace.json for the DSRA app from the official NATS UK drone
restriction dataset (UK AIP, AIXM 5.1 format). Run by the monthly GitHub
Action, but it also works on any computer with Python 3:

    python3 build_airspace.py                  # download the current dataset
    python3 build_airspace.py --file data.zip  # use a file you downloaded

Only the Python standard library is used.
"""
import argparse, datetime as dt, io, json, math, re, sys, urllib.error, urllib.request, zipfile
import xml.etree.ElementTree as ET

PAGE = 'https://nats-uk.ead-it.com/cms-nats/opencms/en/uas-restriction-zones/'
# NATS keep the files in a UAS_AREA_1 folder (seen Nov 2026); the older places are kept as fall-backs.
BASES = ['https://nats-uk.ead-it.com/cms-nats/export/sites/default/en/Publications/digital-datasets/UAS_AREA_1/',
         'https://nats-uk.ead-it.com/cms-nats/opencms/en/Publications/digital-datasets/UAS_AREA_1/',
         'https://nats-uk.ead-it.com/cms-nats/export/sites/default/en/Publications/digital-datasets/',
         'https://nats-uk.ead-it.com/cms-nats/opencms/en/Publications/digital-datasets/']
PAGES = [PAGE, 'https://nats-uk.ead-it.com/cms-nats/opencms/en/Publications/digital-datasets/']
NAME = 'EG_UAS_FR_DS_AREA1_FULL_{}_XML.zip'
AIRAC_BASE = dt.date(2024, 1, 25)          # AIRAC 2401
UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 DSRA-airspace-builder/1.1',
      'Accept': 'text/html,application/xhtml+xml,application/zip,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-GB,en;q=0.9'}

NS = {'aixm': 'http://www.aixm.aero/schema/5.1', 'gml': 'http://www.opengis.net/gml/3.2',
      'xlink': 'http://www.w3.org/1999/xlink'}
A = '{%s}' % NS['aixm']
G = '{%s}' % NS['gml']


# ---------------------------------------------------------------- download
def airac_dates(today):
    """Effective dates of the current cycle, the next one and three before it."""
    n = (today - AIRAC_BASE).days // 28
    return [AIRAC_BASE + dt.timedelta(days=28 * k) for k in (n + 1, n, n - 1, n - 2, n - 3)]


def fetch(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError('HTTP %s %s' % (e.code, e.reason))
    except urllib.error.URLError as e:
        raise RuntimeError('cannot connect (%s)' % e.reason)


def fail(message):
    # "::error::" lines show in the Annotations list on GitHub's run page
    print(message)
    print('::error title=Airspace update failed::' + message.replace('\n', '%0A'))
    sys.exit(1)


def download(today):
    tried = []
    # 1. Links listed on the NATS pages
    for page in PAGES:
        try:
            html = fetch(page).decode('utf-8', 'replace')
        except Exception as e:
            tried.append('page %s: %s' % (page.split('/en/')[-1] or page, e))
            continue
        # Any link (single or double quotes, any folder, any letter case) to a full UAS dataset zip
        found = re.findall(r'''href\s*=\s*["']([^"']*?EG_UAS_FR_DS_AREA1_FULL_(\d{8})[^"']*?\.zip[^"']*)["']''', html, re.I)
        links = sorted(set(found), key=lambda x: x[1], reverse=True)
        if not links:
            zips = re.findall(r'''href\s*=\s*["']([^"']*\.zip[^"']*)["']''', html, re.I)
            tried.append('page %s: opened (%d bytes) but no dataset links found%s' % (page.split('/en/')[-1], len(html),
                         ('; zip links seen: ' + ', '.join(z.split('/')[-1] for z in zips[:4])) if zips else ''))
        for href, date in links:
            if dt.datetime.strptime(date, '%Y%m%d').date() <= today:
                url = href.replace('&amp;', '&')
                url = url if url.startswith('http') else 'https://nats-uk.ead-it.com' + ('' if url.startswith('/') else '/') + url
                try:
                    return fetch(url), date, url
                except Exception as e:
                    tried.append('listed file %s: %s' % (date, e))
                break
        else:
            if links: tried.append('page %s: only future datasets listed (%s)' % (page.split('/en/')[-1], links[0][1]))
    # 2. Build the file name from the AIRAC dates
    for d in airac_dates(today):
        if d > today:
            continue
        for base in BASES:
            url = base + NAME.format(d.strftime('%Y%m%d'))
            try:
                return fetch(url), d.strftime('%Y%m%d'), url
            except Exception as e:
                tried.append('%s (%s%s): %s' % (d, 'export' if '/export/' in base else 'opencms', ' UAS_AREA_1' if 'UAS_AREA_1' in base else '', e))
    fail('Could not download the NATS dataset. Tried:\n' + '\n'.join(tried[:20]))


# ------------------------------------------------------------------ parsing
def nums(text):
    return [float(v) for v in (text or '').split()]


def to_lonlat(pairs):
    """GML in EPSG:4326 is latitude first. Detect and swap to [lon, lat]."""
    if not pairs:
        return pairs
    a, b = pairs[0]
    if 48 <= a <= 62 and -11 <= b <= 4:
        return [[round(q, 5), round(p, 5)] for p, q in pairs]
    return [[round(p, 5), round(q, 5)] for p, q in pairs]


def radius_m(el):
    r = el.find('gml:radius', NS)
    v = float(r.text)
    uom = (r.get('uom') or 'M').upper().strip('[]')
    return v * {'NM': 1852, 'NMI_I': 1852, '[NMI_I]': 1852, 'KM': 1000, 'M': 1, 'FT': 0.3048}.get(uom, 1)


def centre(el):
    pos = el.find('gml:pos', NS)
    if pos is None:
        pos = el.find('.//gml:pos', NS)
    v = nums(pos.text)
    return to_lonlat([(v[0], v[1])])[0]


def offset(lon, lat, dist, bearing):
    br = math.radians(bearing)
    dlat = dist * math.cos(br) / 111320
    dlon = dist * math.sin(br) / (111320 * math.cos(math.radians(lat)))
    return [round(lon + dlon, 5), round(lat + dlat, 5)]


def circle(el, n=48):
    lon, lat = centre(el)
    r = radius_m(el)
    pts = [offset(lon, lat, r, 360 * k / n) for k in range(n)]
    return pts + [pts[0]]


def arc(el, prev_pt):
    """AIXM arcs: angles are bearings from north. Direction follows the angles."""
    lon, lat = centre(el)
    r = radius_m(el)
    s = float(el.findtext('gml:startAngle', '0', NS))
    e = float(el.findtext('gml:endAngle', '0', NS))
    span = e - s
    steps = max(4, int(abs(span) / 7.5))
    return [offset(lon, lat, r, s + span * k / steps) for k in range(steps + 1)]


def ring_points(container):
    pts = []
    for el in container.iter():
        tag = el.tag
        if tag in (G + 'LineStringSegment', G + 'GeodesicString', G + 'LineString', G + 'LinearRing'):
            pl = el.find('gml:posList', NS)
            if pl is not None:
                v = nums(pl.text)
                pts += to_lonlat(list(zip(v[0::2], v[1::2])))
            else:
                pairs = [tuple(nums(p.text)[:2]) for p in el.findall('.//gml:pos', NS)]
                pts += to_lonlat(pairs)
        elif tag == G + 'CircleByCenterPoint':
            return circle(el)
        elif tag in (G + 'ArcByCenterPoint',):
            pts += arc(el, pts[-1] if pts else None)
    if pts and pts[0] != pts[-1]:
        pts.append(pts[0])
    return pts


def limit(vol, which):
    v = vol.find('aixm:%sLimit' % which, NS)
    ref = (vol.findtext('aixm:%sLimitReference' % which, '', NS) or '').strip().upper()
    if v is None or not (v.text or '').strip():
        return ''
    val, uom = v.text.strip().upper(), (v.get('uom') or '').upper()
    if val in ('GND', 'SFC') or (val in ('0', '0.0') and ref in ('SFC', '')):
        return 'Surface'
    if val == 'UNL':
        return 'Unlimited'
    if uom == 'FL' or ref == 'STD':
        return 'FL%s' % val.split('.')[0]
    try:
        num = '{:,}'.format(int(float(val)))
    except ValueError:
        num = val
    unit = 'm' if uom == 'M' else 'ft'
    return ('%s %s %s' % (num, unit, {'SFC': 'above ground', 'MSL': 'above sea level'}.get(ref, ref.lower()))).strip()


def text(ts, name):
    t = ts.findtext('aixm:' + name, '', NS)
    return (t or '').strip()


def parse(xml_bytes):
    root = ET.fromstring(xml_bytes)
    out = []
    for asp in root.iter(A + 'Airspace'):
        for ts in asp.iter(A + 'AirspaceTimeSlice'):
            name = text(ts, 'name') or text(ts, 'designator')
            typ = text(ts, 'type')
            cls = ''
            c = ts.find('.//aixm:classification', NS)
            if c is not None and c.text:
                cls = c.text.strip()
            for vol in ts.iter(A + 'AirspaceVolume'):
                proj = vol.find('aixm:horizontalProjection', NS)
                if proj is None:
                    continue
                pts = ring_points(proj)
                if len(pts) < 4:
                    continue
                lons = [p[0] for p in pts]; lats = [p[1] for p in pts]
                out.append({'n': name, 'd': text(ts, 'designator'), 't': typ, 'c': cls,
                            'lo': limit(vol, 'lower'), 'hi': limit(vol, 'upper'),
                            'b': [min(lons), min(lats), max(lons), max(lats)], 'g': pts})
    return out


def read_dataset(data):
    if data[:2] == b'PK':
        z = zipfile.ZipFile(io.BytesIO(data))
        areas = []
        for name in z.namelist():
            if name.lower().endswith('.xml'):
                areas += parse(z.read(name))
        return areas
    return parse(data)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--file', help='use a downloaded .zip or .xml instead of downloading')
    ap.add_argument('--out', default='airspace.json')
    args = ap.parse_args()
    today = dt.date.today()
    if args.file:
        data = open(args.file, 'rb').read()
        m = re.search(r'(\d{8})', args.file)
        date, url = (m.group(1) if m else today.strftime('%Y%m%d')), args.file
    else:
        data, date, url = download(today)
    try:
        areas = read_dataset(data)
    except Exception as e:
        fail('Downloaded %s (%d bytes, starts %r) but could not read it: %s' % (url, len(data), data[:40], e))
    if not areas:
        fail('Downloaded %s (%d bytes) but found no airspace shapes in it.' % (url, len(data)))
    eff = dt.datetime.strptime(date, '%Y%m%d').date()
    result = {'airac': eff.isoformat(), 'generated': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%MZ'),
              'source': 'NATS UK AIP UAS restriction dataset', 'url': url, 'count': len(areas), 'areas': areas}
    with open(args.out, 'w') as f:
        json.dump(result, f, separators=(',', ':'))
    kinds = {}
    for a in areas:
        k = a['t'] or 'unknown'
        kinds[k] = kinds.get(k, 0) + 1
    print('AIRAC %s: %d areas written to %s' % (eff, len(areas), args.out))
    print('By type: ' + ', '.join('%s %d' % kv for kv in sorted(kinds.items(), key=lambda kv: -kv[1])))


if __name__ == '__main__':
    main()
