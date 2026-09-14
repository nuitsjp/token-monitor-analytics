#!/usr/bin/env python3
"""文書整合の判定スクリプト。結果は報告であり、差し戻しの判断は人が行う。"""
import argparse
import hashlib
import os
import re
import sys
from pathlib import Path

# 状態語の正本: docs/standards/mock-driven-development.md §2
STATUSES = ("未着手", "仕様作成中", "モック作成中", "合意待ち", "実装中", "検証中", "完了")
WIP_SPEC = {"仕様作成中", "モック作成中", "合意待ち"}
WIP_IMPL = {"実装中", "検証中"}
AGREED_REQUIRED = {"実装中", "検証中", "完了"}
EMPTY_CELLS = {"", "-", "--", "---", "—"}
EXCLUDE_DIRS = {".git", "node_modules", "bin", "obj", "dist", "build", ".venv", "venv",
                "vendor", "upstream", "old", "poc", ".playwright-cli"}
EXCLUDE_RELPATHS = {"docs/reference"}
EVIDENCE_EXTRA_EXCLUDE = {"public", "static", "assets", "src", "frontend", "test", "tests"}
EVIDENCE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".log", ".sha256"}
# 行数上限の正本: docs/standards/design-and-documentation.md §3
# docs/architecture.md だけ本プロジェクト固有の上限（docs/document-policy.md の採用記録の差分欄）。
LINE_LIMITS = {"PLAN.md": 100, "docs/project.md": 300,
               "docs/architecture.md": 500, "docs/document-policy.md": 100}
PLACEHOLDER_HASH = "sha256:" + "0" * 64
# 配布元が `--print-hashes` の出力で更新する。
EXPECTED_HASHES = {
    "docs/standards/design-and-documentation.md": "sha256:7c517c12bce2d97edd08e2e1da54cbe3184144dacf6b5b490b7fdd37b674657b",
    "docs/standards/mock-driven-development.md": "sha256:400a06b45634f6e122f9c57067daf2e67988f040d560cd16637cd4a34fb9584f",
}

HEX_RE = re.compile(r"(?<![0-9A-Za-z])[0-9a-fA-F]{7,40}(?![0-9A-Za-z])")
QUOTE_RE = re.compile(r"^\s*>\s*\S")
UC_HEAD_RE = re.compile(r"^###\s+UC-(\d+)\.")
P_HEAD_RE = re.compile(r"^###\s+P-(\d+)\.")
UC_ID_RE = re.compile(r"UC-\d+")
SERIES_RE = re.compile(r"UC-(\d+)-(?:M|X\d+)")
EXT_RE = re.compile(r"UC-\d+-X\d+")
LINK_RE = re.compile(r"!?\[[^\]]*\]\(([^()\s]+)(?:\s+\"[^\"]*\")?\)")
CHECKED_RE = re.compile(r"^\s*[-*]\s+\[[xX]\]")
ABSPATH_RE = re.compile(r"(?<![0-9A-Za-z])[A-Za-z]:[\\/]|/Users/|/home/")
ANCHOR_ID_RE = re.compile(r"<a\s+id=\"([^\"]+)\"")
SLUG_STRIP_RE = re.compile(r"[^\w\-一-龠ぁ-んァ-ヶー]")
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


def uc_bodies(text):
    """`### UC-n.` の本文を UC ID ごとに返す（次の `###` または `##` まで）。"""
    bodies, current, buf = {}, None, []
    for line in text.split("\n"):
        matched = UC_HEAD_RE.match(line)
        if matched:
            if current:
                bodies[current] = "\n".join(buf)
            current, buf = "UC-" + matched.group(1), []
        elif current and line.startswith("##"):
            bodies[current], current, buf = "\n".join(buf), None, []
        elif current is not None:
            buf.append(line)
    if current:
        bodies[current] = "\n".join(buf)
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


def check_checkboxes(plan_text):
    """判定 2: PLAN.md に済みのチェックボックスが残っていないか。"""
    if plan_text is None:
        emit("対象なし", "済みチェックボックス: PLAN.md がない")
        return
    hits = [i for i, line in enumerate(plan_text.split("\n"), 1) if CHECKED_RE.match(line)]
    for lineno in hits:
        emit("NG", "済みチェックボックス: PLAN.md:%d に済みのチェックボックスがある" % lineno)
    if not hits:
        emit("OK", "済みチェックボックス: PLAN.md に済みのチェックボックスはない")


def check_abs_paths(root, docs):
    """判定 3: ローカル絶対パスを含む行がないか。"""
    hits = ["%s:%d" % (rel(root, path), lineno)
            for path, text in sorted(docs.items())
            for lineno, line in enumerate(text.split("\n"), 1) if ABSPATH_RE.search(line)]
    for where in hits:
        emit("NG", "ローカル絶対パス: %s にローカル絶対パスがある" % where)
    if not hits:
        emit("OK", "ローカル絶対パス: 走査対象にローカル絶対パスはない")


def check_overall_agreement(arch_text):
    """判定 4(d): 全体設計の合意欄に提示コミットと引用があるか。"""
    body = section_body(arch_text, "## 全体設計の合意") if arch_text else None
    if body is None:
        emit("NG", "仕掛かり: docs/architecture.md に `## 全体設計の合意` の節がない")
        return
    missing = []
    if not HEX_RE.search("\n".join(line for _, line in body)):
        missing.append("提示コミットのハッシュ")
    if not any(QUOTE_RE.match(line) for _, line in body):
        missing.append("引用行")
    if missing:
        emit("NG", "仕掛かり: `## 全体設計の合意` に %s がない" % "・".join(missing))


def check_progress(table, project_text, arch_text):
    """判定 4: 仕掛かりの本数と、合意記録の有無。"""
    if table is None:
        emit("対象なし", "仕掛かり: PLAN.md の `## 3. ユースケース進捗` に表がない")
        return
    header, rows = table
    bodies = uc_bodies(project_text) if project_text else {}
    spec_rows, impl_rows, agreed_rows = [], [], []
    for lineno, cells in rows:
        uc_id = uc_of(cell(header, cells, "UC ID"))
        status = cell(header, cells, "状態")
        where = "PLAN.md:%d %s" % (lineno, uc_id or "(UC ID なし)")
        if status not in STATUSES:
            emit("NG", "仕掛かり: %s の状態が定義語でない: %s" % (where, status or "(空欄)"))
            continue
        if status in WIP_SPEC or cell(header, cells, "保留理由") not in EMPTY_CELLS:
            spec_rows.append(where)
        if status in WIP_IMPL:
            impl_rows.append(where)
        if status not in AGREED_REQUIRED:
            continue
        agreed_rows.append(where)
        found = HEX_RE.search(cell(header, cells, "合意版"))
        body = bodies.get(uc_id)
        if not found:
            emit("NG", "仕掛かり: %s の合意版に提示コミットのハッシュがない" % where)
        elif body is None:
            emit("NG", "仕掛かり: docs/project.md に %s の本文がない" % uc_id)
        else:
            missing = []
            if found.group(0) not in body:
                missing.append("提示コミット %s" % found.group(0))
            if not any(m.group(1) == uc_id[3:] for m in SERIES_RE.finditer(body)):
                missing.append("系列 ID")
            if not any(QUOTE_RE.match(line) for line in body.split("\n")):
                missing.append("引用行")
            if missing:
                emit("NG", "仕掛かり: docs/project.md の %s 本文に %s がない" % (uc_id, "・".join(missing)))
    if len(spec_rows) > 1:
        emit("NG", "仕掛かり: 仕様合意前の行が %d 件ある: %s" % (len(spec_rows), "、".join(spec_rows)))
    if len(impl_rows) > 1:
        emit("NG", "仕掛かり: 実装中・検証中の行が %d 件ある: %s" % (len(impl_rows), "、".join(impl_rows)))
    if agreed_rows:
        check_overall_agreement(arch_text)
    emit("報告", "仕掛かり: 進捗表 %d 行、仕様合意前 %d 行、実装中・検証中 %d 行、合意版が必要 %d 行"
         % (len(rows), len(spec_rows), len(impl_rows), len(agreed_rows)))


def check_uc_ids(table, project_text):
    """判定 5: PLAN の進捗表、本文見出し、カタログ表で UC ID が一致するか。"""
    plan_ids = [uc_of(cell(table[0], c, "UC ID")) for _, c in table[1]] if table else []
    heads = [UC_HEAD_RE.match(line) for line in (project_text or "").split("\n")]
    head_ids = ["UC-" + m.group(1) for m in heads if m]
    body = section_body(project_text, "## 3. ユースケースと合意") if project_text else None
    catalog = parse_table(body) if body else None
    catalog_ids = [uc_of(cell(catalog[0], c, "UC ID")) for _, c in catalog[1]] if catalog else []
    sources = [("PLAN.md 進捗表", [i for i in plan_ids if i], table is not None),
               ("docs/project.md 見出し", head_ids, project_text is not None),
               ("docs/project.md カタログ表", [i for i in catalog_ids if i], catalog is not None)]
    present = [s for s in sources if s[2]]
    if len(present) < 2:
        emit("対象なし", "UC ID: 比較できる UC ID の一覧が 2 つ揃わない")
        return
    ng = False
    for name, ids, _ in present:
        dups = sorted({i for i in ids if ids.count(i) > 1})
        if dups:
            ng = True
            emit("NG", "UC ID: %s に重複 ID がある: %s" % (name, "、".join(dups)))
    # 進捗表とカタログ表は一致。本文見出しはカタログの部分集合でよく（未着手の UC は本文がなくてよい）、
    # 未着手でない UC には本文が要る。
    plan_set, catalog_set, head_set = set(sources[0][1]), set(sources[2][1]), set(head_ids)
    if table is not None and catalog is not None:
        for uc_id in sorted(plan_set ^ catalog_set, key=lambda x: int(x[3:])):
            ng = True
            where = "docs/project.md カタログ表" if uc_id in plan_set else "PLAN.md 進捗表"
            emit("NG", "UC ID: %s が %s にない" % (uc_id, where))
    if project_text is not None and catalog is not None:
        for uc_id in sorted(head_set - catalog_set, key=lambda x: int(x[3:])):
            ng = True
            emit("NG", "UC ID: %s の本文があるが docs/project.md カタログ表にない" % uc_id)
    if table is not None and project_text is not None:
        for _, cells in table[1]:
            uc_id, status = uc_of(cell(table[0], cells, "UC ID")), cell(table[0], cells, "状態")
            if uc_id and status != "未着手" and uc_id not in head_set:
                ng = True
                emit("NG", "UC ID: %s は %s だが docs/project.md に `### %s.` の本文がない" % (uc_id, status, uc_id))
    if not ng:
        known = sorted(plan_set | catalog_set | head_set, key=lambda x: int(x[3:]))
        emit("OK", "UC ID: %d 件の UC ID が一致している（本文あり %d 件）" % (len(known), len(head_set)))


def check_hashes(root):
    """判定 6: 輸入した標準の正規化ハッシュが期待値と一致するか。"""
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


def check_reports(root, project_text, arch_text):
    """判定 7: 証跡ファイル、行数、ユースケースと実現パターンの数の報告。"""
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
        bodies = sorted(uc_bodies(project_text).items(), key=lambda kv: int(kv[0][3:]))
        detail = "、".join("%s 拡張 %d 本" % (uc, len(set(EXT_RE.findall(body)))) for uc, body in bodies)
        emit("報告", "ユースケース: %d 件%s" % (len(bodies), "（%s）" % detail if bodies else ""))
    if arch_text is not None:
        patterns = sum(1 for line in arch_text.split("\n") if P_HEAD_RE.match(line))
        emit("報告", "実現パターン: docs/architecture.md に %d 件" % patterns)


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
    plan_text = docs.get((root / "PLAN.md").resolve())
    project_text = docs.get((root / "docs" / "project.md").resolve())
    arch_text = docs.get((root / "docs" / "architecture.md").resolve())
    progress = section_body(plan_text, "## 3. ユースケース進捗") if plan_text else None
    table = parse_table(progress) if progress else None
    check_links(root, docs)
    check_checkboxes(plan_text)
    check_abs_paths(root, docs)
    check_progress(table, project_text, arch_text)
    check_uc_ids(table, project_text)
    check_hashes(root)
    check_reports(root, project_text, arch_text)
    print("NG %d 件" % NG_COUNT)
    return 1 if NG_COUNT else 0


if __name__ == "__main__":
    sys.exit(main())
