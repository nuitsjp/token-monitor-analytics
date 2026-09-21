#!/usr/bin/env python3
"""文書整合の判定スクリプト。結果は報告であり、差し戻しの判断は人が行う。"""
import argparse
import hashlib
import os
import re
import sys
from pathlib import Path

EMPTY_CELLS = {"", "-", "--", "---", "—"}
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
    "docs/standards/design-and-documentation.md": "sha256:26747160169c6f7ec30c9774342fd6010e0f1be6cc51104565d81ad17dabb0c3",
    "docs/standards/mock-driven-development.md": "sha256:0f189c865adb71131b77f79a4ef1089532bba4f95841b664cbb45069d7bdcb6b",
}

HEX_RE = re.compile(r"(?<![0-9A-Za-z])[0-9a-fA-F]{7,40}(?![0-9A-Za-z])")
QUOTE_RE = re.compile(r"^\s*>\s*\S")
UC_HEAD_RE = re.compile(r"^#\s+UC-(\d+)\.")
P_HEAD_RE = re.compile(r"^###\s+UCP-(\d+)\.")
UC_ID_RE = re.compile(r"UC-\d+")
SERIES_RE = re.compile(r"UC-(\d+)-(?:M|X\d+)")
EXT_RE = re.compile(r"UC-\d+-X\d+")
LINK_RE = re.compile(r"!?\[[^\]]*\]\(([^()\s]+)(?:\s+\"[^\"]*\")?\)")
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


def check_overall_agreement(arch_text):
    """判定 3(d): 全体設計の合意欄に提示コミットと引用があるか。"""
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


def filled(value):
    return value.strip() not in EMPTY_CELLS and "{{" not in value


def agreement_records(body):
    """合意記録と完成系監査記録を分け、系列 ID・提示コミット・引用の有無を返す。"""
    records = {"合意記録": [], "完成系監査記録": []}
    kind, current = None, None
    for line in body.splitlines():
        if line.startswith(("- ", "#")):
            heading = re.match(r"^- (合意記録|完成系監査記録)(?:[（(:：]|$)", line)
            kind, current = heading.group(1) if heading else None, None
        if kind is None:
            continue
        series = SERIES_RE.search(line)
        if series and "提示コミット:" in line:
            commit = line.split("提示コミット:", 1)[1].split("/", 1)[0].strip().strip("`")
            current = [series.group(0), commit, False]
            records[kind].append(current)
        elif current is not None and QUOTE_RE.match(line) and filled(line.split(">", 1)[1]):
            current[2] = True
    return records


def verification_results(project_text):
    """合否表を系列ごとの [(段階, 合否)] にする。表がなければ None。"""
    body = section_body(project_text, "## 6. 検証結果")
    table = parse_table(body) if body else None
    if table is None:
        return None
    header, rows = table
    if "段階" not in header:
        emit("NG", "仕掛かり: 検証結果の表に `段階` 列がない")
    results = {}
    for lineno, cells in rows:
        series_ids = {m.group(0) for m in SERIES_RE.finditer(cell(header, cells, "UC・系列 ID"))}
        phase = cell(header, cells, "段階")
        result = cell(header, cells, "合否")
        if series_ids and filled(result) and result != "未検証" and phase not in {"1", "2", "3", "4", "5", "6"}:
            emit("NG", "仕掛かり: docs/project.md:%d の記入済み検証結果には段階番号（1〜6）が必要" % lineno)
        for series in series_ids:
            results.setdefault(series, []).append((phase, result))
    return results


def check_progress(project_text, arch_text, uc_docs):
    """判定 3: 合意記録の完全性と、同時に進める系列が1本を超えていないか。"""
    if project_text is None:
        emit("対象なし", "仕掛かり: docs/project.md がない")
        return
    bodies = uc_bodies(uc_docs)
    if not bodies:
        emit("対象なし", "仕掛かり: docs/usecases/ に `# UC-n.` の本文がない")
        return
    described, agreed, audited = set(), set(), set()
    for uc_id, body in sorted(bodies, key=lambda kv: int(kv[0][3:])):
        described |= {m.group(0) for m in SERIES_RE.finditer(body)}
        for kind, records in agreement_records(body).items():
            for series, commit, quoted in records:
                if not filled(commit) and not quoted:
                    continue
                if not series.startswith(uc_id + "-"):
                    emit("NG", "仕掛かり: %s の本文に他のユースケースの%sがある: %s" % (uc_id, kind, series))
                    continue
                missing = []
                if not HEX_RE.fullmatch(commit):
                    missing.append("提示コミットのハッシュ")
                if not quoted:
                    missing.append("利用者の応答の引用行")
                if missing:
                    emit("NG", "仕掛かり: %s の%sに %s がない" % (series, kind, "・".join(missing)))
                else:
                    (agreed if kind == "合意記録" else audited).add(series)
    results = verification_results(project_text)
    required, passed = set(), set()
    if results is None:
        emit("対象なし", "仕掛かり: docs/project.md の `## 6. 検証結果` に表がない")
    else:
        for series, rows in results.items():
            final_results = [result for phase, result in rows if phase == "6"]
            if any(filled(result) and result != "未検証" for result in final_results):
                required.add(series)
            if final_results and all(result == "合格" for result in final_results):
                passed.add(series)
        for series in sorted(required - audited):
            emit("NG", "仕掛かり: %s の段階6の検証結果に対応する完成系監査記録がない" % series)
    for series in sorted((required | audited) - agreed):
        emit("NG", "仕掛かり: %s の完成系監査・段階6の検証に先立つ合意記録がない" % series)
    done = agreed & audited & passed
    wip = sorted((agreed | audited | required) - done)
    if len(wip) > 1:
        emit("NG", "仕掛かり: 合意・監査・段階6の全構成合格が揃っていない着手済み系列が %d 本ある: %s"
             % (len(wip), "、".join(wip)))
    if agreed or audited or required:
        check_overall_agreement(arch_text)
    emit("報告", "仕掛かり: 記述済みの系列 %d 本、合意済み %d 本、完成系監査記録あり %d 本、段階6の全構成合格 %d 本"
         % (len(described), len(agreed), len(audited), len(passed)))


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


def check_reports(root, project_text, arch_text, uc_docs):
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
    project_text = docs.get((root / "docs" / "project.md").resolve())
    arch_text = docs.get((root / "docs" / "architecture.md").resolve())
    uc_docs = {path: text for path, text in docs.items()
               if path.parent == root / "docs" / "usecases"}
    check_links(root, docs)
    check_abs_paths(root, docs)
    check_progress(project_text, arch_text, uc_docs)
    check_uc_ids(project_text, uc_docs)
    check_hashes(root)
    check_reports(root, project_text, arch_text, uc_docs)
    print("NG %d 件" % NG_COUNT)
    return 1 if NG_COUNT else 0


if __name__ == "__main__":
    sys.exit(main())
