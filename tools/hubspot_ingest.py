# -*- coding: utf-8 -*-
"""Pull every Mesh Rider log bundle ever attached to a HubSpot ticket, plus the
ticket text needed to judge whether our fix matched the measured fault.

Read-only. This script issues GETs and search POSTs against the HubSpot API and
never writes to the CRM.

Auth: set HUBSPOT_TOKEN in the environment (private app token, or an OAuth access
token). Never pass it on the command line - the argument list is visible to other
processes and lands in shell history.

    setx HUBSPOT_TOKEN "pat-na1-..."        # Windows, new shell afterwards
    export HUBSPOT_TOKEN=pat-na1-...        # bash

Two stages, on purpose. Enumeration is free and safe; downloading is neither, so
it does not happen unless you ask:

    python tools/hubspot_ingest.py                      # enumerate, download nothing
    python tools/hubspot_ingest.py --download           # fetch + extract bundles
    python tools/hubspot_ingest.py --download --since 2024-01-01

Required scopes: tickets (read), crm.objects.companies.read, and files (read).

Output:
    <bundles>/<ticket>_<file>/      extracted bundle, one dir per attachment
    <bundles>/labels.json           dir name -> human label, for the analyser
    data/tickets.json               the contract failure_profile.py consumes
    data/hubspot_manifest.json      every attachment seen, downloaded or not
"""
import argparse, io, json, os, re, sys, tarfile, time, urllib.error, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = 'https://api.hubapi.com'

# What counts as a support bundle. Deliberately generous on extension and narrow
# on content: an unrelated .tar.gz costs one wasted download, a missed bundle
# costs a hole in the analysis.
BUNDLE_RE = re.compile(r'\.(tar\.gz|tgz|tar|gz|zip)\b|longtermmon|longtermlog|support.?bundle', re.I)

TICKET_PROPS = ['subject', 'content', 'hs_pipeline_stage', 'hs_pipeline', 'createdate',
                'closed_date', 'hs_ticket_priority', 'source_type', 'hs_resolution']
NOTE_PROPS = ['hs_attachment_ids', 'hs_note_body', 'hs_timestamp']
EMAIL_PROPS = ['hs_attachment_ids', 'hs_email_text', 'hs_email_subject', 'hs_timestamp']


# ---------------------------------------------------------------- transport
class Http:
    """Minimal HubSpot client with the two behaviours that matter at this scale:
    it honours 429 backoff, and it degrades instead of dying on unknown properties."""

    def __init__(self, token, verbose=False):
        self.token = token
        self.verbose = verbose
        self.calls = 0

    def _req(self, method, path, body=None, params=None):
        url = BASE + path
        if params:
            url += '?' + urllib.parse.urlencode(params, doseq=True)
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(url, data=data, method=method)
        r.add_header('Authorization', 'Bearer ' + self.token)
        r.add_header('Content-Type', 'application/json')
        self.calls += 1
        with urllib.request.urlopen(r, timeout=90) as resp:
            return json.loads(resp.read().decode() or '{}')

    def call(self, method, path, body=None, params=None, tolerate=()):
        delay = 1.0
        for attempt in range(6):
            try:
                return self._req(method, path, body, params)
            except urllib.error.HTTPError as e:
                detail = ''
                try:
                    detail = e.read().decode()[:400]
                except Exception:
                    pass
                if e.code in tolerate:
                    return None
                # 429 is a rate limit and 5xx is transient; both are worth waiting out.
                if e.code == 429 or 500 <= e.code < 600:
                    if attempt == 5:
                        raise SystemExit('HubSpot %s after 6 attempts: %s' % (e.code, detail))
                    wait = float(e.headers.get('Retry-After') or delay)
                    if self.verbose:
                        print('  %s on %s, waiting %.0fs' % (e.code, path, wait), file=sys.stderr)
                    time.sleep(wait)
                    delay = min(delay * 2, 30)
                    continue
                if e.code in (401, 403):
                    raise SystemExit(
                        'HubSpot %s on %s.\n%s\n\nThe token is missing a scope or is invalid. '
                        'This script needs: tickets (read), crm.objects.companies.read, files (read).'
                        % (e.code, path, detail))
                raise SystemExit('HubSpot %s on %s: %s' % (e.code, path, detail))
            except urllib.error.URLError as e:
                if attempt == 5:
                    raise SystemExit('network error talking to HubSpot: %s' % e)
                time.sleep(delay)
                delay = min(delay * 2, 30)
        return None

    def paged(self, path, params=None, limit=100):
        """Yield every result across pages. HubSpot caps page size at 100."""
        params = dict(params or {})
        params['limit'] = limit
        after = None
        while True:
            if after:
                params['after'] = after
            page = self.call('GET', path, params=params) or {}
            for row in page.get('results', []):
                yield row
            after = ((page.get('paging') or {}).get('next') or {}).get('after')
            if not after:
                return

    def batch_read(self, obj, ids, props):
        """Batch-read with graceful degradation: if HubSpot rejects a property name
        we retry without it rather than losing the whole batch. Portal schemas vary,
        and hs_resolution in particular is not present everywhere."""
        out = {}
        props = list(props)
        for i in range(0, len(ids), 100):
            chunk = [{'id': str(x)} for x in ids[i:i + 100]]
            body = {'properties': props, 'inputs': chunk}
            res = self.call('POST', '/crm/v3/objects/%s/batch/read' % obj, body=body, tolerate=(400,))
            if res is None:
                # find the offending property by elimination, once, then carry on
                keep = []
                for p in props:
                    probe = self.call('POST', '/crm/v3/objects/%s/batch/read' % obj,
                                      body={'properties': [p], 'inputs': chunk[:1]}, tolerate=(400,))
                    if probe is not None:
                        keep.append(p)
                dropped = [p for p in props if p not in keep]
                if dropped:
                    print('  note: %s has no %s property here, skipping it'
                          % (obj, ', '.join(dropped)), file=sys.stderr)
                props = keep or ['hs_object_id']
                res = self.call('POST', '/crm/v3/objects/%s/batch/read' % obj,
                                body={'properties': props, 'inputs': chunk}, tolerate=(400,)) or {}
            for row in res.get('results', []):
                out[str(row['id'])] = row.get('properties', {})
        return out


# ---------------------------------------------------------------- helpers
def detag(html):
    if not html:
        return ''
    t = re.sub(r'(?i)<br\s*/?>|</p>|</div>', '\n', html)
    t = re.sub(r'<[^>]+>', '', t)
    t = (t.replace('&nbsp;', ' ').replace('&amp;', '&').replace('&lt;', '<')
          .replace('&gt;', '>').replace('&quot;', '"').replace('&#39;', "'"))
    return re.sub(r'\n{3,}', '\n\n', t).strip()


def safe_dirname(s):
    s = re.sub(r'[^A-Za-z0-9._ -]+', '_', s or '').strip('._ ')
    return (s or 'bundle')[:110]


def extract(blob, dest):
    """Extract a bundle. Refuses paths that escape dest - these archives come from
    outside, and tarfile will happily write to ../.. if you let it."""
    os.makedirs(dest, exist_ok=True)
    try:
        tf = tarfile.open(fileobj=io.BytesIO(blob))
    except tarfile.TarError:
        return False, 'not a readable tar archive'
    root = os.path.realpath(dest)
    with tf:
        members = []
        for mem in tf.getmembers():
            if not (mem.isfile() or mem.isdir()):
                continue                                  # skip links and devices
            target = os.path.realpath(os.path.join(dest, mem.name))
            if target == root or target.startswith(root + os.sep):
                members.append(mem)
        if not members:
            return False, 'archive held no usable files'
        tf.extractall(dest, members=members)
    return True, '%d entries' % len(members)


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--download', action='store_true',
                    help='actually fetch and extract bundles (default: enumerate only)')
    ap.add_argument('--since', help='only tickets created on/after YYYY-MM-DD (default: all time)')
    ap.add_argument('--bundles', default=os.path.join(HERE, 'data', 'hubspot_bundles'))
    ap.add_argument('--max-mb', type=float, default=80.0, help='skip any single file larger than this')
    ap.add_argument('-v', '--verbose', action='store_true')
    a = ap.parse_args()

    token = os.environ.get('HUBSPOT_TOKEN') or os.environ.get('HUBSPOT_PRIVATE_APP_TOKEN')
    if not token:
        raise SystemExit('HUBSPOT_TOKEN is not set. Export it and re-run; do not pass it as an '
                         'argument. See the header of this file.')
    h = Http(token, a.verbose)

    # ---- 1. every ticket, with the note/email IDs attached to it
    print('reading tickets...')
    params = {'properties': TICKET_PROPS, 'associations': ['notes', 'emails', 'companies']}
    tickets = []
    for t in h.paged('/crm/v3/objects/tickets', params):
        if a.since:
            created = (t.get('properties') or {}).get('createdate') or ''
            if created[:10] < a.since:
                continue
        tickets.append(t)
    print('  %d tickets' % len(tickets))
    if not tickets:
        raise SystemExit('No tickets returned. Check the token has the tickets read scope.')

    def assoc(t, kind):
        return [x['id'] for x in ((t.get('associations') or {}).get(kind) or {}).get('results', [])]

    note_ids = sorted({i for t in tickets for i in assoc(t, 'notes')})
    email_ids = sorted({i for t in tickets for i in assoc(t, 'emails')})
    company_ids = sorted({i for t in tickets for i in assoc(t, 'companies')})
    print('  %d notes, %d emails, %d companies associated'
          % (len(note_ids), len(email_ids), len(company_ids)))

    notes = h.batch_read('notes', note_ids, NOTE_PROPS) if note_ids else {}
    emails = h.batch_read('emails', email_ids, EMAIL_PROPS) if email_ids else {}
    companies = h.batch_read('companies', company_ids, ['name']) if company_ids else {}

    # ---- 2. attachment IDs, semicolon-separated on the engagement
    def att_ids(props):
        raw = (props or {}).get('hs_attachment_ids') or ''
        return [x for x in re.split(r'[;,]', str(raw)) if x.strip().isdigit()]

    manifest, per_ticket = [], {}
    for t in tickets:
        tid = t['id']
        p = t.get('properties') or {}
        fids = []
        for nid in assoc(t, 'notes'):
            fids += att_ids(notes.get(nid))
        for eid in assoc(t, 'emails'):
            fids += att_ids(emails.get(eid))
        cnames = [companies.get(c, {}).get('name') for c in assoc(t, 'companies')]
        cnames = [c for c in cnames if c]

        # resolution evidence: the ticket body plus every note on it, in time order
        chunks = []
        if p.get('hs_resolution'):
            chunks.append(detag(p['hs_resolution']))
        if p.get('content'):
            chunks.append(detag(p['content']))
        for nid in sorted(assoc(t, 'notes'),
                          key=lambda n: (notes.get(n, {}) or {}).get('hs_timestamp') or ''):
            body = detag((notes.get(nid) or {}).get('hs_note_body'))
            if body:
                chunks.append(body)

        per_ticket[tid] = {
            'id': tid,
            'company': cnames[0] if cnames else None,
            'created': (p.get('createdate') or '')[:10],
            'subject': p.get('subject'),
            'stage': p.get('hs_pipeline_stage'),
            'closed': (p.get('closed_date') or '')[:10] or None,
            'resolution': '\n\n'.join(c for c in chunks if c)[:8000],
            'file_ids': sorted(set(fids)),
            'bundles': [],
        }

    all_fids = sorted({f for v in per_ticket.values() for f in v['file_ids']})
    print('  %d distinct attachments referenced' % len(all_fids))

    # ---- 3. which of those attachments are actually log bundles
    print('reading file metadata...')
    files = {}
    for fid in all_fids:
        meta = h.call('GET', '/files/v3/files/%s' % fid, tolerate=(404,))
        if meta:
            files[fid] = meta

    for tid, tk in per_ticket.items():
        for fid in tk['file_ids']:
            f = files.get(fid)
            if not f:
                manifest.append({'ticket': tid, 'file_id': fid, 'name': None,
                                 'is_bundle': False, 'status': 'metadata unavailable'})
                continue
            name = f.get('name') or ''
            ext = (f.get('extension') or '').lstrip('.')
            full = name if name.lower().endswith(ext.lower()) else (name + '.' + ext if ext else name)
            size = f.get('size') or 0
            is_b = bool(BUNDLE_RE.search(full))
            manifest.append({'ticket': tid, 'file_id': fid, 'name': full,
                             'size_bytes': size, 'is_bundle': is_b,
                             'company': tk['company'], 'created': tk['created'],
                             'status': 'pending' if is_b else 'not a bundle'})

    bundles = [m for m in manifest if m['is_bundle']]
    tickets_with = sorted({m['ticket'] for m in bundles})
    total_mb = sum(m.get('size_bytes') or 0 for m in bundles) / 1e6
    print('\n%d bundle-shaped attachments across %d tickets, %.1f MB total'
          % (len(bundles), len(tickets_with), total_mb))
    for m in bundles[:25]:
        print('  %-11s %-52s %7.2f MB  %s' % (m['ticket'], (m['name'] or '')[:52],
                                              (m.get('size_bytes') or 0) / 1e6,
                                              m.get('company') or ''))
    if len(bundles) > 25:
        print('  ... and %d more' % (len(bundles) - 25))

    os.makedirs(os.path.join(HERE, 'data'), exist_ok=True)
    mpath = os.path.join(HERE, 'data', 'hubspot_manifest.json')

    if not a.download:
        with open(mpath, 'w', encoding='utf-8') as fh:
            json.dump({'tickets': len(tickets), 'attachments': len(manifest),
                       'bundles': len(bundles), 'total_mb': round(total_mb, 1),
                       'api_calls': h.calls, 'downloaded': False,
                       'manifest': manifest}, fh, indent=1)
        print('\nEnumeration only - nothing downloaded. Manifest: %s' % mpath)
        print('Re-run with --download to fetch and extract these %d bundles.' % len(bundles))
        return

    # ---- 4. download + extract
    os.makedirs(a.bundles, exist_ok=True)
    labels, ok, failed = {}, 0, 0
    for m in bundles:
        size_mb = (m.get('size_bytes') or 0) / 1e6
        if size_mb > a.max_mb:
            m['status'] = 'skipped, %.0f MB over the %.0f MB limit' % (size_mb, a.max_mb)
            print('  skip %s (%s)' % (m['name'], m['status']))
            continue
        # private files 404 on the plain URL, so always go through signed-url
        su = h.call('GET', '/files/v3/files/%s/signed-url' % m['file_id'], tolerate=(404, 403))
        url = (su or {}).get('url') or (files.get(m['file_id'], {}) or {}).get('url')
        if not url:
            m['status'] = 'no downloadable URL'
            failed += 1
            continue
        try:
            with urllib.request.urlopen(url, timeout=180) as r:
                blob = r.read()
        except Exception as e:
            m['status'] = 'download failed: %s' % e
            failed += 1
            continue

        dname = safe_dirname('%s_%s' % (m['ticket'], m['name']))
        good, why = extract(blob, os.path.join(a.bundles, dname))
        if good:
            m['status'] = 'extracted (%s)' % why
            m['dir'] = dname
            tk = per_ticket[m['ticket']]
            tk['bundles'].append(dname)
            labels[dname] = '%s - %s' % (tk.get('company') or 'ticket ' + m['ticket'],
                                         m['name'])
            ok += 1
        else:
            m['status'] = 'extract failed: %s' % why
            failed += 1
        print('  %-52s %s' % ((m['name'] or '')[:52], m['status']))

    with open(os.path.join(a.bundles, 'labels.json'), 'w', encoding='utf-8') as fh:
        json.dump(labels, fh, indent=1)

    # tickets.json: one row per extracted bundle, keyed the way the analyser names it
    rows = []
    for tk in per_ticket.values():
        for dname in tk['bundles']:
            rows.append({'bundle': dname, 'id': tk['id'], 'company': tk['company'],
                         'created': tk['created'], 'subject': tk['subject'],
                         'stage': tk['stage'], 'closed': tk['closed'],
                         'resolution': tk['resolution']})
    tpath = os.path.join(HERE, 'data', 'tickets.json')
    with open(tpath, 'w', encoding='utf-8') as fh:
        json.dump(rows, fh, indent=1)
    with open(mpath, 'w', encoding='utf-8') as fh:
        json.dump({'tickets': len(tickets), 'attachments': len(manifest),
                   'bundles': len(bundles), 'extracted': ok, 'failed': failed,
                   'api_calls': h.calls, 'downloaded': True, 'manifest': manifest}, fh, indent=1)

    print('\nextracted %d, failed %d' % (ok, failed))
    print('bundles  -> %s' % a.bundles)
    print('tickets  -> %s' % tpath)
    print('manifest -> %s' % mpath)
    print('\nNext:\n  python tools/analyze_mesh_rider_logs.py --bundles "%s"\n'
          '  python tools/failure_profile.py' % a.bundles)


if __name__ == '__main__':
    main()
