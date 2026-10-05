import io, re, glob

total = 0
report = []
RULES = [
    (re.compile(r'text-slate-500(?![\w-])'), 'text-slate-500 dark:text-slate-400'),
    (re.compile(r'text-slate-600(?![\w-])'), 'text-slate-600 dark:text-slate-400'),
    (re.compile(r'text-slate-700(?![\w-])'), 'text-slate-700 dark:text-slate-300'),
    (re.compile(r'border-slate-200(?![\w-])'), 'border-slate-200 dark:border-slate-700'),
]
CLASS_RE = re.compile(r'(className=")((?:[^"\\]|\\.)*)(")')
TPL_RE = re.compile(r"(className=\{`)((?:[^`\\]|\\.)*)(`)")
files = glob.glob('src/pages/*.tsx') + glob.glob('src/components/**/*.tsx', recursive=True)
for f in files:
    if '.test.' in f:
        continue
    s = io.open(f, encoding='utf-8').read()
    orig = s
    def fix(m):
        global total
        cls = m.group(2)
        if 'dark:' in cls:
            return m.group(0)
        new = cls
        for pat, rep in RULES:
            new = pat.sub(rep, new)
        if new != cls:
            total += 1
        return f'{m.group(1)}{new}{m.group(3)}'
    s = CLASS_RE.sub(fix, s)
    s = TPL_RE.sub(fix, s)
    if s != orig:
        io.open(f, 'w', encoding='utf-8', newline='').write(s)
        report.append(f)
print('files changed:', len(report))
print('class-string sites patched:', total)
for f in report:
    print(' ', f)
