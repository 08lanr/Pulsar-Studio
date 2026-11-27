import io, sys
def edit(path, pairs, imports=None):
    raw = io.open(path, encoding="utf-8", newline="").read()
    crlf = raw.count("\r\n"); lf = raw.count("\n") - crlf
    nl = "\r\n" if crlf >= lf else "\n"
    s = raw.replace("\r\n", "\n")
    for old, new in pairs:
        if old not in s:
            sys.exit("MISSING in %s:\n%s" % (path, old[:300]))
        s = s.replace(old, new, 1)
    if imports:
        lines = s.split("\n")
        idx = max([i for i, l in enumerate(lines) if l.startswith("import ")], default=-1)
        for imp in reversed(imports):
            if imp not in s:
                lines.insert(idx + 1, imp)
        s = "\n".join(lines)
    io.open(path, "w", encoding="utf-8", newline="").write(s.replace("\n", nl))
    print("edited", path, repr(nl))
