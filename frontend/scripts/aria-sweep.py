import io, re, glob

LABELS = {
    'Trash2': '删除', 'RefreshCw': '刷新', 'Plus': '添加', 'Pencil': '编辑',
    'Eye': '查看', 'EyeOff': '隐藏', 'Copy': '复制', 'Download': '下载', 'Upload': '上传',
    'Send': '发送', 'X': '关闭', 'ChevronRight': '展开', 'ChevronDown': '展开',
    'ChevronLeft': '上一项', 'ChevronUp': '收起', 'Settings': '设置', 'Filter': '筛选',
    'Search': '搜索', 'Play': '播放', 'Pause': '暂停', 'ExternalLink': '打开链接',
    'Camera': '更换头像', 'User': '用户', 'Link2': '链接', 'Check': '确认',
    'ArrowRight': '下一步', 'ArrowLeft': '返回', 'Bell': '通知', 'Star': '收藏',
    'Archive': '归档', 'MoreHorizontal': '更多', 'Info': '详情', 'AlertCircle': '提示',
}

BTN_RE = re.compile(r'(<Button\b[^>]*?)(>\s*)(<(\w+) size=\{\d+\}[^>]*?/>)\s*</Button>', re.S)
count = 0
files_report = []
for f in glob.glob('src/pages/*.tsx') + glob.glob('src/components/**/*.tsx', recursive=True):
    if '.test.' in f:
        continue
    s = io.open(f, encoding='utf-8').read()
    orig = s
    def fix(m):
        global count
        head, mid, icon, icon_name = m.group(1), m.group(2), m.group(3), m.group(4)
        if 'aria-label' in head or 'title=' in head:
            return m.group(0)
        label = LABELS.get(icon_name)
        if not label:
            return m.group(0)
        head = head + ' aria-label="' + label + '"'
        count += 1
        return head + mid + icon + '</Button>'
    s = BTN_RE.sub(fix, s)
    if s != orig:
        io.open(f, 'w', encoding='utf-8', newline='').write(s)
        files_report.append(f)
print('buttons patched:', count)
for f in files_report:
    print(' ', f)
