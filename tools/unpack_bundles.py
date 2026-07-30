# -*- coding: utf-8 -*-
"""Recursively unpack customer log deliveries into the layout the analyser expects.

Customers send whatever their machine produced: a zip of a zip of a tar.gz, bare
.gz files, macOS Finder archives with AppleDouble resource forks, and occasionally a
photo of the drone. This walks all of it, finds every longtermlog directory however
deep it is buried, and stages each one as a bundle.

    python tools/unpack_bundles.py "C:/Users/jus24/Downloads/Ascent.zip" ... --out DIR
    python tools/analyze_mesh_rider_logs.py --bundles DIR

Output layout, matching the analyser's */longtermlog discovery marker:

    DIR/<label>/inner/longtermlog/...
    DIR/labels.json

Safety: archive members that would escape the destination are dropped, not written.
These files come from outside and tar/zip will both happily write to ../.. if allowed.
"""
import argparse, gzip, io, json, os, re, shutil, sys, tarfile, tempfile, zipfile

MAX_DEPTH = 6                      # a zip of a zip of a tar.gz is real; 6 is generous
ARCHIVE_EXT = ('.zip', '.tar.gz', '.tgz', '.tar', '.gz')
META_MARKERS = ('iw_dev', 'fes_model', 'os-release')

# extraction dir -> the extraction dir of the archive that contained it
PARENT = {}
# longtermlog dir -> count of rotated .log files folded into its nested/ subdir
ROTATED = {}

def mesh_mac(lt):
    """The mesh radio's own MAC, for de-duplicating a delivery that ships the same
    capture twice (a folder and a zip of that folder is common).

    IMPORTANT, same trap as the analyser: these radios expose wlan0 (mesh) and wlan1
    (a 5 GHz Wi-Fi hotspot). Take the MESH interface's address, never simply the first
    'addr' in iw_dev - that is usually the hotspot and yields the wrong identity.
    """
    txt = ''
    for f in ('iw_dev', 'iw_wlan0_info'):
        p = os.path.join(lt, f)
        if os.path.exists(p):
            try:
                txt += open(p, encoding='utf-8', errors='replace').read(6000) + '\n'
            except Exception:
                pass
    if not txt:
        return None
    for blk in re.split(r'(?=phy#)', txt):
        if 'mesh point' in blk or 'wlan0' in blk:
            m = re.search(r'addr ((?:[0-9a-f]{2}:){5}[0-9a-f]{2})', blk, re.I)
            if m:
                return m.group(1).lower()
    m = re.search(r'addr ((?:[0-9a-f]{2}:){5}[0-9a-f]{2})', txt, re.I)
    return m.group(1).lower() if m else None

def is_radio_root(lt):
    """A longtermlog carrying device metadata is one radio's bundle. One carrying only
    .log files is a rotated fragment of some radio's history - a customer delivery can
    hold hundreds of those, and staging each as its own radio would be nonsense."""
    return any(os.path.exists(os.path.join(lt, m)) for m in META_MARKERS)

def owning_extract_dir(path, roots):
    """Walk the flattened-extraction parent chain until we reach a dir that holds a
    radio root, so a fragment is attributed to the radio it actually came from."""
    seen = set()
    cur = path
    while cur and cur not in seen:
        seen.add(cur)
        for r in roots:
            if r.startswith(cur + os.sep) or r == cur:
                return cur
        cur = PARENT.get(cur)
    return None

def is_junk(name):
    """macOS Finder litter. AppleDouble files are not archives even when named .gz."""
    base = os.path.basename(name)
    return ('__MACOSX' in name or base.startswith('._')
            or base in ('.DS_Store', 'Icon\r') or not base)

def safe_members_tar(tf, dest):
    root = os.path.realpath(dest)
    out = []
    for m in tf.getmembers():
        if not (m.isfile() or m.isdir()) or is_junk(m.name):
            continue
        tgt = os.path.realpath(os.path.join(dest, m.name))
        if tgt == root or tgt.startswith(root + os.sep):
            out.append(m)
    return out

def safe_names_zip(zf, dest):
    root = os.path.realpath(dest)
    out = []
    for n in zf.namelist():
        if is_junk(n):
            continue
        tgt = os.path.realpath(os.path.join(dest, n))
        if tgt == root or tgt.startswith(root + os.sep):
            out.append(n)
    return out

def _extract_all(tf, dest, members):
    """tarfile.extractall with the member filter pinned, so Python 3.14's default
    change does not silently alter behaviour. Traversal is already checked by caller."""
    try:
        tf.extractall(dest, members=members, filter='tar')
    except TypeError:                       # Python < 3.12 has no filter argument
        tf.extractall(dest, members=members)

def unpack(path, dest, depth=0, log=None, prov=None, logical=None, work=None, ctr=None):
    """Extract one archive into dest, then recurse into any archives it contained.

    Nested archives go into fresh SHORT sibling directories under `work` rather than
    into a subdirectory named after the archive. Windows MAX_PATH is 260 characters
    and a zip-of-zip-of-tar.gz named after a customer blows straight through it if the
    extraction path grows at every level.
    """
    if depth > MAX_DEPTH:
        log and log('  ! depth limit reached at %s' % os.path.basename(path))
        return
    os.makedirs(dest, exist_ok=True)
    low = path.lower()
    disp = os.path.basename(path)[:44]
    try:
        if zipfile.is_zipfile(path):
            with zipfile.ZipFile(path) as zf:
                names = safe_names_zip(zf, dest)
                zf.extractall(dest, members=names)
            log and log('  %szip    %-44s -> %d entries' % ('  ' * depth, disp, len(names)))
        elif tarfile.is_tarfile(path):
            with tarfile.open(path) as tf:
                mem = safe_members_tar(tf, dest)
                _extract_all(tf, dest, mem)
            log and log('  %star    %-44s -> %d entries' % ('  ' * depth, disp, len(mem)))
        elif low.endswith('.gz'):
            # A bare .gz is either a gzipped tar or a gzipped single file. Try tar
            # first, since customers often name a tar.gz with just .gz.
            with open(path, 'rb') as fh:
                blob = gzip.decompress(fh.read())
            try:
                with tarfile.open(fileobj=io.BytesIO(blob)) as tf:
                    mem = safe_members_tar(tf, dest)
                    _extract_all(tf, dest, mem)
                log and log('  %sgz/tar %-44s -> %d entries' % ('  ' * depth, disp, len(mem)))
            except tarfile.TarError:
                stem = re.sub(r'\.gz$', '', os.path.basename(path), flags=re.I)
                with open(os.path.join(dest, stem or 'payload'), 'wb') as out:
                    out.write(blob)
                log and log('  %sgz     %-44s -> 1 file' % ('  ' * depth, disp))
        else:
            return
    except Exception as e:
        log and log('  ! could not read %s: %s' % (disp, e))
        return

    if prov is not None:
        prov[dest] = logical or os.path.basename(path)

    # recurse into nested archives that just appeared, each into its own short dir.
    # PARENT is recorded because staging is flattened for path-length reasons: without
    # it a rotated log fragment cannot be traced back to the radio it came from.
    nested = []
    for r, _dirs, files in os.walk(dest):
        for f in files:
            if not is_junk(f) and f.lower().endswith(ARCHIVE_EXT):
                nested.append(os.path.join(r, f))
    for p in nested:
        ctr[0] += 1
        sub = os.path.join(work, 'a%d' % ctr[0])
        rel = os.path.basename(p)
        PARENT[sub] = dest
        holder = os.path.dirname(p)
        if os.path.basename(holder).lower() == 'longtermlog':
            # A rotated archive sitting inside a longtermlog belongs to THAT radio.
            # Unpack it aside, then fold its .log files into the radio's nested/ dir,
            # which the analyser already globs. Attribution by position beats trying to
            # reconstruct ancestry through a flattened staging tree.
            unpack(p, sub, depth + 1, None, None, logical, work, ctr)
            nest = os.path.join(holder, 'nested')
            moved = 0
            for r2, _d, files in os.walk(sub):
                for f in files:
                    if f.endswith('.log'):
                        os.makedirs(nest, exist_ok=True)
                        tgt = os.path.join(nest, f)
                        if not os.path.exists(tgt):
                            shutil.move(os.path.join(r2, f), tgt)
                            moved += 1
            shutil.rmtree(sub, ignore_errors=True)
            if moved:
                ROTATED[holder] = ROTATED.get(holder, 0) + moved
        else:
            unpack(p, sub, depth + 1, log, prov, '%s / %s' % (logical, rel), work, ctr)

def find_longtermlog(root):
    """Every longtermlog directory under root, deepest-first so nested wins are kept."""
    hits = []
    for r, dirs, _f in os.walk(root):
        for d in dirs:
            if d == 'longtermlog':
                hits.append(os.path.join(r, d))
    return sorted(set(hits))

def has_content(p):
    """A longtermlog with no parseable log files is not worth staging."""
    for r, _d, files in os.walk(p):
        for f in files:
            if f.endswith('.log') or f in ('fes_model', 'date', 'iw_dev'):
                return True
    return False

def label_from(account, logical):
    """Readable label: account from the delivery name, node/date detail from the
    chain of archive names it was nested inside."""
    parts = re.split(r'\s*/\s*', logical or '')
    parts = [re.sub(r'\.(tar\.gz|tgz|tar|zip|gz)$', '', p, flags=re.I) for p in parts]
    parts = [p for p in parts if p and p.lower() != account.lower()]
    # the informative pieces are node names and dates, not wrapper names
    keep = [p for p in parts if re.search(r'gcs|drone|uav|air|ground|relay|craft|\d{4,}', p, re.I)]
    detail = ' '.join(dict.fromkeys(keep or parts))[:60].strip()
    return ('%s - %s' % (account, detail)).strip(' -') if detail else account

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('archives', nargs='+')
    ap.add_argument('--out', required=True, help='bundles directory for the analyser')
    ap.add_argument('--work', help='staging directory (default: <out>/_staging)')
    a = ap.parse_args()

    out = os.path.abspath(a.out)
    # Staging lives in a deliberately SHORT path. Nested customer archives plus a long
    # destination is how you hit the 260-character Windows limit.
    work = os.path.abspath(a.work or os.path.join(tempfile.gettempdir(), 'dlx'))
    os.makedirs(out, exist_ok=True)
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work, exist_ok=True)
    if len(out) > 120:
        print('WARNING: --out is %d characters. Windows caps paths at 260 and bundle '
              'contents nest several levels deeper; use a shorter path if extraction '
              'fails.' % len(out))
    def log(s):
        print(s)

    labels, staged, skipped = {}, 0, []
    ctr = [0]
    for arc in a.archives:
        if not os.path.exists(arc):
            log('MISSING %s' % arc)
            continue
        name = os.path.basename(arc)
        account = re.sub(r'\.(zip|tar\.gz|tgz|tar|gz)$', '', name, flags=re.I)
        log('=' * 68)
        log('%s  (%.1f MB)' % (name, os.path.getsize(arc) / 1e6))
        ctr[0] += 1
        root = os.path.join(work, 'a%d' % ctr[0])
        prov = {}
        unpack(arc, root, 0, log, prov, account, work, ctr)

        # every extraction directory from this delivery, so nested finds are included
        mine = sorted(prov)
        found = []
        for d in mine:
            for lt in find_longtermlog(d):
                if lt not in found:
                    found.append(lt)
        roots = [lt for lt in found if is_radio_root(lt)]
        loose = [lt for lt in found if lt not in roots and has_content(lt)]
        log('  longtermlog dirs: %d  (radio roots %d, other %d)'
            % (len(found), len(roots), len(loose)))
        if not roots:
            why = ('%d log directories but no device metadata, so no radio can be '
                   'identified' % len(loose)) if loose else \
                  'no longtermlog directory anywhere in the delivery'
            skipped.append((name, why))
            log('  ! not stageable: %s' % why)
            continue

        # De-duplicate by mesh MAC: deliveries commonly contain the same capture twice,
        # once as a folder and once as a zip of that folder. Keep the richest copy.
        def richness(lt):
            n = sum(len(f) for _r, _d, f in os.walk(lt))
            return (n, ROTATED.get(lt, 0))
        # One bundle per radio, keyed on mesh MAC, with every capture of that radio
        # UNIONED by log filename.
        #
        # This is the only correct merge. A radio's longtermlog accumulates, so a later
        # capture is normally a superset of an earlier one: the 23Jun and 25Jun pulls of
        # the same aircraft shared identical per-peer statistics, proving the overlap.
        # Treating them as independent bundles double-counts the same telemetry, while
        # keeping only one throws away whatever the other uniquely held. Union by
        # filename does neither, and is also right when the customer cleared logs
        # between flights (then the sets are disjoint and the union is simply both).
        by_mac = {}
        for lt in sorted(roots, key=richness, reverse=True):
            mac = mesh_mac(lt)
            ident = mac or ('path:' + os.path.basename(os.path.dirname(lt)))
            by_mac.setdefault(ident, []).append(lt)
        if len(by_mac) < len(roots):
            log('  merged %d capture(s) into %d distinct radio(s) by mesh MAC'
                % (len(roots), len(by_mac)))
        for ident, caps in sorted(by_mac.items()):
            primary = caps[0]                       # richest capture supplies metadata
            lab = label_from(account, prov.get(
                max((d for d in mine if primary.startswith(d)), key=len, default=root), account))
            key = re.sub(r'[^A-Za-z0-9._ -]+', '_', lab)[:48]
            n, base = 2, key
            while key in labels:
                key = '%s %d' % (base, n); n += 1
            bdir = os.path.join(out, key, 'inner')
            dst = os.path.join(bdir, 'longtermlog')
            os.makedirs(bdir, exist_ok=True)
            shutil.copytree(primary, dst, dirs_exist_ok=True)
            # union in any log file the other captures of this radio uniquely hold
            extra, nest = 0, os.path.join(dst, 'nested')
            seen = set()
            for r2, _d, files in os.walk(dst):
                seen.update(f for f in files if f.endswith('.log'))
            for lt in caps[1:]:
                for r2, _d, files in os.walk(lt):
                    for f in files:
                        if f.endswith('.log') and f not in seen:
                            os.makedirs(nest, exist_ok=True)
                            shutil.copy2(os.path.join(r2, f), os.path.join(nest, f))
                            seen.add(f)
                            extra += 1
            labels[key] = lab
            staged += 1
            log('  + staged  %-40s mac=%s  %d captures, %d logs (+%d unioned)'
                % (key[:40], (ident or '?')[:17], len(caps), len(seen), extra))

    with open(os.path.join(out, 'labels.json'), 'w', encoding='utf-8') as f:
        json.dump(labels, f, indent=1, ensure_ascii=False)
    log('=' * 68)
    log('staged %d bundle(s) into %s' % (staged, out))
    for n, why in skipped:
        log('NOT STAGED: %s - %s' % (n, why))
    if staged:
        log('')
        log('next: python tools/analyze_mesh_rider_logs.py --bundles "%s"' % out)
    return 0 if staged else 1

if __name__ == '__main__':
    sys.exit(main())
