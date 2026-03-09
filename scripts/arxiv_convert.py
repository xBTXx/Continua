#!/usr/bin/env python3
import argparse
import gzip
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

try:
    from pylatexenc.latex2text import LatexNodes2Text
except Exception:
    LatexNodes2Text = None


def emit(payload):
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()


def fail(message):
    emit({"status": "error", "error": message})
    sys.exit(1)


def read_text(path):
    with open(path, "r", encoding="utf-8", errors="ignore") as handle:
        return handle.read()


def write_text(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(content)


def strip_latex_basic(latex):
    text = re.sub(r"(?<!\\\\)%.*", "", latex)
    text = re.sub(r"\\\\", "\n", text)
    text = re.sub(r"\\begin\\{[^}]+\\}", "", text)
    text = re.sub(r"\\end\\{[^}]+\\}", "", text)
    text = re.sub(r"\\[a-zA-Z]+\\*?(?:\\[[^\\]]*\\])?", "", text)
    text = re.sub(r"\\{", "{", text)
    text = re.sub(r"\\}", "}", text)
    text = re.sub(r"\\\$", "$", text)
    text = re.sub(r"\\&", "&", text)
    text = re.sub(r"\\#", "#", text)
    text = re.sub(r"\\_", "_", text)
    text = re.sub(r"\\%", "%", text)
    text = re.sub(r"\\~\\{\\}", "~", text)
    text = re.sub(r"\\^\\{\\}", "^", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def latex_to_text(latex):
    if LatexNodes2Text is not None:
        return LatexNodes2Text().latex_to_text(latex)
    return strip_latex_basic(latex)


def extract_source(source_path, temp_dir):
    if source_path is None:
        return None
    if os.path.isdir(source_path):
        return source_path
    try:
        with tarfile.open(source_path, "r:*") as archive:
            safe_members = []
            for member in archive.getmembers():
                member_path = os.path.realpath(os.path.join(temp_dir, member.name))
                if member_path.startswith(os.path.realpath(temp_dir) + os.sep):
                    safe_members.append(member)
            archive.extractall(temp_dir, members=safe_members)
        return temp_dir
    except tarfile.TarError:
        pass
    try:
        with gzip.open(source_path, "rt", encoding="utf-8", errors="ignore") as handle:
            content = handle.read()
        tex_path = os.path.join(temp_dir, "source.tex")
        write_text(tex_path, content)
        return temp_dir
    except OSError:
        pass
    try:
        content = read_text(source_path)
        tex_path = os.path.join(temp_dir, "source.tex")
        write_text(tex_path, content)
        return temp_dir
    except OSError:
        return None


def find_tex_files(root_dir):
    candidates = []
    for dirpath, _, filenames in os.walk(root_dir):
        for filename in filenames:
            if not filename.lower().endswith(".tex"):
                continue
            path = os.path.join(dirpath, filename)
            try:
                size = os.path.getsize(path)
            except OSError:
                size = 0
            has_doc = False
            try:
                content = read_text(path)
                has_doc = "\\begin{document}" in content
            except OSError:
                has_doc = False
            candidates.append((has_doc, size, path))
    if not candidates:
        return None
    candidates.sort(key=lambda item: (item[0], item[1]))
    return candidates[-1][2]


def convert_latex(tex_path, out_path):
    pandoc_bin = shutil.which("pandoc")
    if pandoc_bin:
        result = subprocess.run(
            [
                pandoc_bin,
                "--from=latex",
                "--to=gfm",
                "--wrap=none",
                tex_path,
                "-o",
                out_path,
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        if result.returncode == 0:
            return "pandoc"
    latex = read_text(tex_path)
    content = latex_to_text(latex)
    write_text(out_path, content)
    return "latex2text"


def extract_pdf_text(pdf_path):
    try:
        import fitz  # type: ignore

        doc = fitz.open(pdf_path)
        chunks = []
        for page in doc:
            chunks.append(page.get_text())
        doc.close()
        return "\n\n".join(chunks)
    except Exception:
        pass
    try:
        from pdfminer.high_level import extract_text  # type: ignore

        return extract_text(pdf_path)
    except Exception:
        pass
    if shutil.which("pdftotext"):
        with tempfile.TemporaryDirectory() as temp_dir:
            out_file = os.path.join(temp_dir, "pdf.txt")
            result = subprocess.run(
                ["pdftotext", pdf_path, out_file],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            if result.returncode == 0 and os.path.exists(out_file):
                return read_text(out_file)
    return None


def convert_pdf(pdf_path, out_path):
    text = extract_pdf_text(pdf_path)
    if not text:
        return None
    text = re.sub(r"\n{3,}", "\n\n", text)
    write_text(out_path, text.strip())
    return "pdf-text"


def count_words(text):
    return len(re.findall(r"\b\w+\b", text))


def main():
    parser = argparse.ArgumentParser(description="Convert arXiv sources to Markdown.")
    parser.add_argument("--source", help="Path to arXiv e-print source.")
    parser.add_argument("--pdf", help="Path to PDF fallback.")
    parser.add_argument("--out", required=True, help="Output Markdown path.")
    args = parser.parse_args()

    source_path = args.source if args.source else None
    pdf_path = args.pdf if args.pdf else None
    out_path = args.out

    method = None
    used = None

    with tempfile.TemporaryDirectory() as temp_dir:
        source_root = extract_source(source_path, temp_dir)
        if source_root:
            tex_path = find_tex_files(source_root)
            if tex_path:
                try:
                    method = convert_latex(tex_path, out_path)
                    used = "source"
                except Exception:
                    method = None
                    used = None

        if method is None and pdf_path:
            method = convert_pdf(pdf_path, out_path)
            if method:
                used = "pdf"

    if method is None:
        fail("No convertible source found.")

    try:
        content = read_text(out_path)
    except OSError:
        fail("Output could not be read after conversion.")

    emit(
        {
            "status": "ok",
            "method": method,
            "source": used,
            "word_count": count_words(content),
        }
    )


if __name__ == "__main__":
    main()
