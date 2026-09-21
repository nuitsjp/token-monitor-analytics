#!/usr/bin/env python3
"""文書整合の判定スクリプト。結果は報告であり、差し戻しの判断は人が行う。"""
import argparse
import hashlib
import os
import re
import sys
from pathlib import Path

EXCLUDE_DIRS = {".git", "node_modules", "bin", "obj", "dist", "build", ".venv", "venv",
                "vendor", "upstream", "old", "poc", ".playwright-cli"}
EXCLUDE_RELPATHS = {"docs/reference"}
EVIDENCE_EXTRA_EXCLUDE = {"public", "static", "assets", "src", "frontend", "test", "tests"}
EVIDENCE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".log", ".sha256"}
# 行数上限の正本: docs/standards/design-and-documentation.md §3
LINE_LIMITS = {"docs/project.md": 300, "docs/architecture.md": 200,
               "docs/document-policy.md": 100}
PLACEHOLDER_HASH = "sha256:" + "0" * 64
# 配布元が `--print-hashes` の出力で更新する。
EXPECTED_HASHES = {
    "docs/standards/design-and-documentation.md": "sha256:548affce5207701b1e82df5e5f5bb27b48c4370d6c4135b3bc9d011bef11699e",
    "docs/standards/mock-driven-development.md": "sha256:3fb773669cebb4eaaee937bb9b1ae32663c070abf36dfad1c6c2d39bb8d00d70",
}

UC_HEAD_RE = re.compile(r"^#\s+UC-(\d+)\.")
DESIGN_UCP_HEAD_RE = re.compile(r"^#\s+UCP-(\d+)\.")
DESIGN_UCP_FILE_RE = re.compile(r"^UCP-\d+\.md$")
UC_ID_RE = re.compile(r"UC-\d+")
EXT_RE = re.compile(r"UC-\d+-X\d+")
LINK_RE = re.compile(r"!?\[[^\]]*\]\(([^()\s]+)(?:\s+\"[^\"]*\")?\)")
ABSPATH_RE = re.compile(r"(?<![0-9A-Za-z])[A-Za-z]:[\\/]|/Users/|/home/")
ANCHOR_ID_RE = re.compile(r"<a\s+id=\"([^\"]+)\"")
SLUG_STRIP_RE = re.compile(r"[^\w\-一-龠ぁ-んァ-ヶー]")
ADR_ID_RE = re.compile(r"\bADR(?:[-_ ]?\d+)\b", re.IGNORECASE)
DUPLICATE_MIN_CHARS = 60
NG_COUNT = 0


def emit(tag, message):
    global NG_COUNT
    if tag == "NG":
        NG_COUNT += 1
    print("[%s] %s" % (tag, message))


def read_text(path):
    """BOM を除き、改行を LF に揃えて読む。"""
    return path.read_bytes().decode("utf-8-sig", errors="replace").replace("\r\n", "\n").replace("\r", "\n")


def norm_hash(path):
    body = (read_text(path).rstrip("\n") + "\n").encode("utf-8")
    return "sha256:" + hashlib.sha256(body).hexdigest()


def rel(root, path):
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.name


def walk(root, extra_exclude=frozenset()):
    """除外ディレクトリを枝刈りしながら (ディレクトリ, 子ディレクトリ名, ファイル名) を返す。"""
    for dirpath, dirnames, filenames in os.walk(root):
        here = Path(dirpath)
        dirnames[:] = sorted(d for d in dirnames
                             if d not in EXCLUDE_DIRS and d not in extra_exclude
                             and rel(root, here / d) not in EXCLUDE_RELPATHS)
        yield here, list(dirnames), sorted(filenames)


def anchors_of(text):
    """`<a id="...">` と見出しの単純スラグを集めた集合を返す。"""
    ids = set(ANCHOR_ID_RE.findall(text))
    for line in text.split("\n"):
        head = line.strip()
        if head.startswith("#"):
            ids.add(SLUG_STRIP_RE.sub("", re.sub(r"\s+", "-", head.lstrip("#").strip().lower())))
    return ids


def heading_key(line):
    """見出しを (レベル, 節番号を除いた題) に正規化する。既存プロジェクトの節番号の違いを吸収する。"""
    head = line.strip()
    level = len(head) - len(head.lstrip("#"))
    return level, re.sub(r"^\d+\.\s*", "", head.lstrip("#").strip())


def section_body(text, heading):
    """見出し（節番号は無視、題は前方一致）で節本文を [(行番号, 行)] として返す。無ければ None。"""
    lines = text.split("\n")
    want_level, want_title = heading_key(heading)
    start, level = None, 0
    for i, line in enumerate(lines, 1):
        head = line.strip()
        if start is None:
            if head.startswith("#"):
                got_level, got_title = heading_key(head)
                if got_level == want_level and got_title.startswith(want_title):
                    start, level = i, got_level
        elif head.startswith("#") and len(head) - len(head.lstrip("#")) <= level:
            return list(enumerate(lines[start:i - 1], start + 1))
    return None if start is None else list(enumerate(lines[start:], start + 1))


def parse_table(body):
    """節本文の最初の表を (見出しセル, [(行番号, セル列)]) で返す。表が無ければ None。"""
    header, rows = None, []
    for lineno, line in body:
        cells = line.strip()
        if cells.startswith("|"):
            cells = [c.strip() for c in cells.strip("|").split("|")]
            if header is None:
                header = cells
            elif not all(c and set(c) <= set("-: ") for c in cells):
                rows.append((lineno, cells))
        elif header is not None and cells:
            break
    return None if header is None else (header, rows)


def cell(header, cells, name):
    if name not in header:
        return ""
    index = header.index(name)
    return cells[index] if index < len(cells) else ""


def uc_of(text):
    found = UC_ID_RE.search(text)
    return found.group(0) if found else ""


def uc_bodies(uc_docs):
    """各 UC ファイルの `# UC-n.` と本文を返す。見出しの不備は判定4で報告する。"""
    bodies = []
    for path, text in sorted(uc_docs.items()):
        heads = [(i, m) for i, line in enumerate(text.splitlines())
                 if (m := UC_HEAD_RE.match(line))]
        if len(heads) == 1:
            i, matched = heads[0]
            bodies.append(("UC-" + matched.group(1), "\n".join(text.splitlines()[i + 1:])))
    return bodies


def check_links(root, docs):
    """判定 1: リンク先のファイルとアンカーが解決できるか。"""
    if not docs:
        emit("対象なし", "リンク: 走査対象の Markdown がない")
        return
    anchors = {path: anchors_of(text) for path, text in docs.items()}
    bad = []
    for path, text in sorted(docs.items()):
        for lineno, line in enumerate(text.split("\n"), 1):
            for target in LINK_RE.findall(line):
                if target.startswith(("http://", "https://", "mailto:")):
                    continue
                where = "%s:%d" % (rel(root, path), lineno)
                filepart, _, anchor = target.partition("#")
                dest = path
                if filepart:
                    dest = (path.parent / filepart).resolve()
                    if not dest.exists():
                        bad.append("%s リンク先が存在しない: %s" % (where, target))
                        continue
                if anchor and dest.suffix.lower() == ".md" and dest.is_file():
                    if dest not in anchors:
                        anchors[dest] = anchors_of(read_text(dest))
                    if anchor not in anchors[dest]:
                        bad.append("%s アンカーが存在しない: %s" % (where, target))
    for message in bad:
        emit("NG", "リンク: " + message)
    if not bad:
        emit("OK", "リンク: 未解決のリンクとアンカーはない")


def check_abs_paths(root, docs):
    """判定 2: ローカル絶対パスを含む行がないか。"""
    hits = ["%s:%d" % (rel(root, path), lineno)
            for path, text in sorted(docs.items())
            for lineno, line in enumerate(text.split("\n"), 1) if ABSPATH_RE.search(line)]
    for where in hits:
        emit("NG", "ローカル絶対パス: %s にローカル絶対パスがある" % where)
    if not hits:
        emit("OK", "ローカル絶対パス: 走査対象にローカル絶対パスはない")


OLD_RECORD_LABEL_RE = re.compile(
    r"^(?:設計判断|決定(?:経緯|履歴|記録)|全体設計の合意|"
    r"(?:[^:：|/]+の)?(?:改訂合意(?:記録)?|合意記録|完成系監査記録)|"
    r"完成系監査(?:記録|中の[^:：|/]*)|段階\s*3(?:の[^:：|/]*)?|進捗|現在地|"
    r"検証(?:結果|状況|状態)|承認(?:原文|の原文)|応答(?:の)?原文|利用者の(?:応答|承認)原文|提示コミット|"
    r"論点(?:と|への)回答)"
    r"(?:\s*(?:ID|番号))?(?:\s*[（(][^）)]*[）)])?\s*(?:[:：]|$)",
)
OLD_RECORD_HEADING_RE = re.compile(
    r"^(?:設計判断|決定(?:経緯|履歴|記録)|全体設計の合意|"
    r"(?:[^:：|/]+の)?(?:改訂合意(?:記録)?|合意記録|完成系監査記録)|"
    r"完成系監査(?:記録|中の)|段階\s*3(?:の|[：:])(?:変更|差分|修正|保留|確認|記録|等)|"
    r"現在地|承認(?:原文|の原文)|応答(?:の)?原文|利用者の(?:応答|承認)原文|提示コミット|"
    r"論点(?:と|への)回答)(?=$|[\s：:（(])"
)
DECISION_BASENAMES = {
    "adr.md", "adrs.md", "decision.md", "decisions.md", "decision-record.md",
    "decision-records.md", "decision-log.md", "decision-logs.md", "decision-history.md",
    "design-decision.md", "design-decisions.md", "architecture-decisions.md",
    "決定記録.md", "決定履歴.md", "設計判断.md",
}
FENCE_RE = re.compile(r"^\s{0,3}(`{3,}|~{3,})")


def unquote_markdown(line):
    """引用記号を取り除き、引用内の Markdown 構造も判定できるようにする。"""
    value = line
    while True:
        matched = re.match(r"^\s{0,3}>\s?", value)
        if not matched:
            return value
        value = value[matched.end():]


def heading_title(line):
    """Markdown 見出しの題名を返す。見出しでなければ None。"""
    value = unquote_markdown(line).strip()
    matched = re.match(r"^#{1,6}\s+(.+?)\s*#*\s*$", value)
    if not matched:
        return None
    title = matched.group(1).strip()
    return re.sub(r"^\d+(?:\.\d+)*[.)、：:]?\s*", "", title)


def label_candidates(line):
    """記入ラベルとして解釈できる行の先頭候補を返す。"""
    value = unquote_markdown(line).strip()
    values = [value]
    values.extend(part.strip() for part in value.strip("|").split("|"))
    values.extend(part.strip() for part in value.split("/"))
    candidates = []
    for candidate in values:
        candidate = re.sub(r"^(?:[-*+]\s+|\d+[.)]\s+)", "", candidate)
        candidate = re.sub(r"^\*\*(.*?)\*\*", r"\1", candidate)
        candidate = re.sub(r"^`(.*?)`", r"\1", candidate)
        candidate = candidate.strip("`*")
        candidate = re.sub(r"\*+(?=[:：])", "", candidate)
        candidates.append(candidate.strip())
    return candidates


def is_old_record_heading(line):
    title = heading_title(line)
    if not title:
        return False
    base = re.split(r"[：:（(]", title, maxsplit=1)[0].strip()
    if OLD_RECORD_HEADING_RE.match(title):
        return True
    if re.match(r"^(?:完成系監査中の.+|段階\s*[1-6]の(?:.*案採用|変更|表示調整|修正).*)", title):
        return True
    if base in {"検証結果", "検証状況", "検証状態"}:
        return True
    return bool(re.fullmatch(r"(?:開発|作業)?進捗(?:一覧|状況|状態|履歴|記録)?", base))


def is_old_record_label(line):
    return any(OLD_RECORD_LABEL_RE.match(candidate) for candidate in label_candidates(line))


def split_table_line(line):
    value = unquote_markdown(line).strip()
    cells, current, escaped = [], [], False
    saw_pipe = False
    for char in value:
        if char == "|" and not escaped:
            cells.append("".join(current).replace(r"\|", "|").strip())
            current = []
            saw_pipe = True
        else:
            current.append(char)
        escaped = char == "\\" and not escaped
    trailing_pipe = saw_pipe and not current
    if not saw_pipe:
        return None
    cells.append("".join(current).replace(r"\|", "|").strip())
    if value.startswith("|"):
        cells = cells[1:]
    if trailing_pipe:
        cells = cells[:-1]
    return cells


def table_blocks(text):
    """Markdown 表の連続行を [(先頭行番号, 行)] として返す。"""
    lines = text.splitlines()
    blocks = []
    index = 0
    while index < len(lines):
        parsed = table_at(lines, index)
        if parsed is None:
            index += 1
            continue
        rows, index = parsed
        blocks.append((rows[0][0], rows))
    return blocks


def table_separator(cells):
    return bool(cells) and all(re.fullmatch(r":?-+:?", cell) for cell in cells)


def table_at(lines, index):
    """指定行から始まるGFM表を [(行番号, セル列)], 次の行番号として返す。"""
    if index + 1 >= len(lines):
        return None
    header = split_table_line(lines[index])
    separator = split_table_line(lines[index + 1])
    if (header is None or separator is None or len(header) != len(separator)
            or not table_separator(separator)):
        return None
    rows = [(index + 1, header), (index + 2, separator)]
    index += 2
    while index < len(lines):
        cells = split_table_line(lines[index])
        if cells is None:
            break
        rows.append((index + 1, cells))
        index += 1
    return rows, index


def looks_like_verification_table(rows):
    """合否・実行日・版/CI参照を組み合わせた旧検証表を判定する。"""
    header = rows[0][1]
    normalized = {
        re.sub(r"\s+", " ", cell.strip()).strip("`*_~").casefold()
        for cell in header
    }
    has_result = bool(normalized & {
        "合否", "検証結果", "実行結果", "実施結果", "判定", "ステータス", "結果",
        "status", "result", "pass/fail", "pass / fail",
    })
    has_date = bool(normalized & {"実行日", "実施日", "検証日", "実行日時", "日付", "date", "execution date"})
    has_reference = bool(normalized & {
        "対象コミットまたは ci 参照", "対象コミット", "対象版", "コミット", "コミット id",
        "コミットハッシュ", "ci 参照", "ci リンク", "commit", "revision", "build",
    })
    has_subject = bool(normalized & {
        "uc", "uc id", "uc・系列 id", "系列", "構成", "テスト", "テスト項目",
        "test", "test case", "scenario", "case",
    })
    return ((has_result and has_date and has_reference)
            or (has_result and has_subject))


def looks_like_decision_file(root, path):
    relative = Path(rel(root, path))
    parts = {part.casefold() for part in relative.parts[:-1]}
    name = path.name.casefold()
    stem = path.stem.casefold()
    if parts & {"adr", "adrs", "decisions", "decision-records"}:
        return True
    if name in DECISION_BASENAMES:
        return True
    return bool(re.match(r"^adr[-_ ]?\d+", stem, re.I)
                or re.search(r"(?:decision|design-decision)[-_ ]?(?:record|log|history)s?(?:[-_ ]?\d+)?$", stem, re.I))


def content_documents(root, docs):
    """禁止記録判定の対象文書を返す（輸入標準と AGENTS.md は除外）。"""
    result = {}
    for path, text in docs.items():
        relative = Path(rel(root, path))
        if path.name.casefold() == "agents.md":
            continue
        if relative.parts[:2] == ("docs", "standards"):
            continue
        if relative.parts[:2] == ("docs", "reference"):
            continue
        result[path] = text
    return result


def duplicate_normalize(value):
    """空白と Markdown の行境界だけを正規化し、完全一致を比較する。"""
    value = re.sub(r"\s+", " ", value).strip()
    return value


def is_link_only(value):
    value = re.sub(r"^(?:[-*+]\s+|\d+[.)]\s+)", "", value.strip())
    links = re.findall(r"!?\[[^\]]*\]\([^)]*\)", value)
    if not links:
        return False
    remainder = value
    for link in links:
        remainder = remainder.replace(link, "")
    remainder = re.sub(r"[`*_~\s:：、。,.!?！？()（）<>→⇒|/\\-]+", "", remainder)
    remainder = re.sub(r"(?:参照|参照先|詳細|以下|こちら|see|refer|link)$", "", remainder, flags=re.I)
    return not remainder


def duplicate_candidates(text):
    """段落と表本文行を [(行番号, 正規化本文)] として返す。"""
    lines = text.splitlines()
    candidates = []
    paragraph = []

    def flush_paragraph():
        nonlocal paragraph
        if paragraph:
            value = duplicate_normalize(" ".join(line for _, line in paragraph))
            if len(value) >= DUPLICATE_MIN_CHARS and not is_link_only(value):
                candidates.append((paragraph[0][0], value))
            paragraph = []

    index = 0
    in_fence = False
    fence_char = ""
    fence_length = 0
    while index < len(lines):
        raw = lines[index]
        unquoted = unquote_markdown(raw)
        stripped = unquoted.strip()
        fence = FENCE_RE.match(unquoted)
        if fence:
            flush_paragraph()
            if not in_fence:
                in_fence = True
                fence_char = fence.group(1)[0]
                fence_length = len(fence.group(1))
            elif (fence.group(1)[0] == fence_char
                  and len(fence.group(1)) >= fence_length
                  and not unquoted[fence.end():].strip()):
                in_fence, fence_char, fence_length = False, "", 0
            index += 1
            continue
        if in_fence:
            index += 1
            continue
        if not stripped:
            flush_paragraph()
            index += 1
            continue
        if heading_title(raw):
            flush_paragraph()
            index += 1
            continue
        parsed = table_at(lines, index)
        if parsed is not None:
            rows, index = parsed
            flush_paragraph()
            for lineno, row in rows[2:]:
                value = duplicate_normalize(" | ".join(row))
                if len(value) >= DUPLICATE_MIN_CHARS and not is_link_only(value):
                    candidates.append((lineno, value))
            continue
        if re.match(r"^(?:[-*+]\s+|\d+[.)]\s+)", stripped):
            flush_paragraph()
            stripped = re.sub(r"^(?:[-*+]\s+|\d+[.)]\s+)", "", stripped)
        paragraph.append((index + 1, stripped))
        index += 1
    flush_paragraph()
    return candidates


def check_forbidden_records(root, docs):
    """判定 3: 旧記録形式の残存と完全一致する長い本文の重複を報告する。"""
    targets = content_documents(root, docs)
    if not targets:
        emit("対象なし", "禁止記録・重複本文: 対象 Markdown がない")
        return

    hits = []
    duplicate_index = {}
    for path, text in sorted(targets.items()):
        where_path = rel(root, path)
        if looks_like_decision_file(root, path):
            hits.append("%s は ADR/決定記録のファイル名または配置" % where_path)
        lines = text.splitlines()
        for lineno, line in enumerate(lines, 1):
            title = heading_title(line)
            if title and (is_old_record_heading(line) or ADR_ID_RE.search(title)):
                hits.append("%s:%d に旧記録の見出しがある" % (where_path, lineno))
            if is_old_record_label(line):
                hits.append("%s:%d に旧記録の記入ラベルがある" % (where_path, lineno))
            value = unquote_markdown(line).strip()
            if (ADR_ID_RE.search(value)
                    and (title or re.match(r"^(?:[-*+]\s+|\d+[.)]\s+)", value))):
                hits.append("%s:%d に ADR の ID がある" % (where_path, lineno))
        for start, rows in table_blocks(text):
            header = rows[0][1]
            all_cells = [cell for _, row in rows for cell in row]
            if looks_like_verification_table(rows):
                hits.append("%s:%d に旧検証表がある" % (where_path, start))
            if (any(ADR_ID_RE.search(cell) for cell in all_cells)
                    and any(re.search(r"(?:ADR|決定記録|decision)", cell, re.I) for cell in header + all_cells)):
                ids = sorted({match.group(0) for cell in all_cells for match in ADR_ID_RE.finditer(cell)})
                suffix = "（%s）" % "、".join(ids) if ids else ""
                hits.append("%s:%d に ADR/決定記録の表がある%s" % (where_path, start, suffix))
        for lineno, value in duplicate_candidates(text):
            duplicate_index.setdefault(value, []).append("%s:%d" % (where_path, lineno))

    for hit in hits:
        emit("NG", "禁止記録・重複本文: " + hit)
    for value, locations in sorted(duplicate_index.items()):
        if len(locations) > 1:
            emit("NG", "禁止記録・重複本文: 完全一致する長い本文が重複している: %s" % "、".join(locations))
    if not hits and not any(len(locations) > 1 for locations in duplicate_index.values()):
        emit("OK", "禁止記録・重複本文: 旧記録形式と完全一致する長い本文の重複はない")


def check_uc_ids(project_text, uc_docs):
    """判定 4: UC ファイル名・本文見出しと project.md のカタログ表が整合するか。"""
    if project_text is None:
        emit("対象なし", "UC ID: docs/project.md がない")
        return
    head_ids, ng = [], False
    for path, text in sorted(uc_docs.items()):
        ids = ["UC-" + m.group(1) for line in text.splitlines()
               if (m := UC_HEAD_RE.match(line))]
        head_ids.extend(ids)
        if len(ids) != 1:
            ng = True
            emit("NG", "UC ID: docs/usecases/%s の `# UC-n.` 見出しは1件必要（実測 %d 件）"
                 % (path.name, len(ids)))
        elif path.stem != ids[0]:
            ng = True
            emit("NG", "UC ID: docs/usecases/%s のファイル名と本文 ID %s が一致しない"
                 % (path.name, ids[0]))
    body = section_body(project_text, "## 3. ユースケース一覧")
    catalog = parse_table(body) if body else None
    if catalog is None:
        emit("対象なし", "UC ID: docs/project.md にカタログ表がない")
        return
    catalog_ids = []
    for lineno, cells in catalog[1]:
        value = cell(catalog[0], cells, "UC ID")
        uc_id = uc_of(value)
        if not uc_id:
            continue
        catalog_ids.append(uc_id)
        targets = LINK_RE.findall(value)
        if targets and targets != ["usecases/%s.md" % uc_id]:
            ng = True
            emit("NG", "UC ID: docs/project.md:%d の %s のリンク先は usecases/%s.md が必要"
                 % (lineno, uc_id, uc_id))
    for name, ids in (("docs/usecases/ 見出し", head_ids),
                      ("docs/project.md カタログ表", catalog_ids)):
        dups = sorted({i for i in ids if ids.count(i) > 1})
        if dups:
            ng = True
            emit("NG", "UC ID: %s に重複 ID がある: %s" % (name, "、".join(dups)))
    # 本文はカタログ表の部分集合でよい（着手していない UC は本文がなくてよい）。
    head_set, catalog_set = set(head_ids), set(catalog_ids)
    for uc_id in sorted(head_set - catalog_set, key=lambda x: int(x[3:])):
        ng = True
        emit("NG", "UC ID: %s の本文があるが docs/project.md カタログ表にない" % uc_id)
    if not ng:
        known = sorted(head_set | catalog_set, key=lambda x: int(x[3:]))
        emit("OK", "UC ID: %d 件の UC ID が一致している（本文あり %d 件）" % (len(known), len(head_set)))


def check_hashes(root):
    """判定 5: 輸入した標準の正規化ハッシュが期待値と一致するか。"""
    for relpath, expected in EXPECTED_HASHES.items():
        path = root / relpath
        if not path.is_file():
            emit("対象なし", "標準のハッシュ: %s がない" % relpath)
        elif norm_hash(path) == expected:
            emit("OK", "標準のハッシュ: %s は期待値と一致する" % relpath)
        else:
            emit("NG", "標準のハッシュ: %s が期待値と異なる（期待 %s、実測 %s）"
                 % (relpath, expected, norm_hash(path)))
            emit("報告", "標準のハッシュ: 差分の記録があっても報告する。")
    emit("報告", "標準のハッシュ: このスクリプト自身の正規化ハッシュは %s" % norm_hash(Path(__file__)))


def check_reports(root, project_text, uc_docs, design_docs):
    """判定 6: 証跡ファイル、行数、ユースケースと実現パターンの数の報告。"""
    count, total, verification = 0, 0, []
    for here, dirnames, filenames in walk(root, EVIDENCE_EXTRA_EXCLUDE):
        verification += [rel(root, here / d) for d in dirnames if d == "verification"]
        for name in filenames:
            path = here / name
            if path.suffix.lower() in EVIDENCE_EXTS:
                count, total = count + 1, total + path.stat().st_size
    emit("報告", "証跡ファイル: 該当拡張子 %d 件、合計 %d バイト、verification ディレクトリ %s"
         % (count, total, "、".join(verification) if verification else "なし"))
    for relpath, limit in LINE_LIMITS.items():
        path = root / relpath
        if not path.is_file():
            emit("対象なし", "行数: %s がない" % relpath)
            continue
        lines = len(read_text(path).splitlines())
        if lines > limit:
            emit("NG", "行数: %s は %d 行で上限 %d 行を超える" % (relpath, lines, limit))
        else:
            emit("報告", "行数: %s は %d 行（上限 %d 行）" % (relpath, lines, limit))
    if project_text is not None:
        bodies = sorted(uc_bodies(uc_docs), key=lambda kv: int(kv[0][3:]))
        detail = "、".join("%s 拡張 %d 本" % (uc, len(set(EXT_RE.findall(body)))) for uc, body in bodies)
        emit("報告", "ユースケース: %d 件%s" % (len(bodies), "（%s）" % detail if bodies else ""))
    if (root / "docs" / "design").is_dir():
        patterns = 0
        for path, text in design_docs.items():
            if not DESIGN_UCP_FILE_RE.match(path.name):
                continue
            first_heading = next((line for line in text.split("\n")
                                  if line.lstrip().startswith("#")), "")
            if DESIGN_UCP_HEAD_RE.match(first_heading):
                patterns += 1
        emit("報告", "実現パターン: docs/design/ の UCP 文書に %d 件" % patterns)


def print_hashes(root):
    print("EXPECTED_HASHES = {")
    for relpath in EXPECTED_HASHES:
        path = root / relpath
        print('    "%s": "%s",' % (relpath, norm_hash(path) if path.is_file() else PLACEHOLDER_HASH))
    print("}")


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="文書整合を報告する（差し戻しの判断は人が行う）。")
    parser.add_argument("root", nargs="?", default=".", help="判定対象のルート（既定はカレントディレクトリ）")
    parser.add_argument("--print-hashes", action="store_true", help="EXPECTED_HASHES のリテラルを出力する")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    if args.print_hashes:
        print_hashes(root)
        return 0
    docs = {}
    for here, _, filenames in walk(root):
        for name in filenames:
            if name.lower().endswith(".md"):
                docs[(here / name).resolve()] = read_text(here / name)
    project_text = docs.get((root / "docs" / "project.md").resolve())
    uc_docs = {path: text for path, text in docs.items()
               if path.parent == root / "docs" / "usecases"}
    design_docs = {path: text for path, text in docs.items()
                   if path.parent == root / "docs" / "design"}
    check_links(root, docs)
    check_abs_paths(root, docs)
    check_forbidden_records(root, docs)
    check_uc_ids(project_text, uc_docs)
    check_hashes(root)
    check_reports(root, project_text, uc_docs, design_docs)
    print("NG %d 件" % NG_COUNT)
    return 1 if NG_COUNT else 0


if __name__ == "__main__":
    sys.exit(main())
