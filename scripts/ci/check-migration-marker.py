"""Classify new SQLite migrations conservatively before they enter a release."""

import re
import subprocess
import sys


# Preserve statement separators while hiding SQL comments and quoted values.
# An identifier or string cannot supply an executable keyword.
TOKEN = re.compile(
    r"""--[^\n]*|/\*[\s\S]*?\*/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[\w$]+|\s+|.""",
    re.DOTALL,
)


def needs_review(sql):
    tokens = []
    for match in TOKEN.finditer(sql):
        token = match[0]
        if token.startswith(("--", "/*")) or token.isspace():
            continue
        tokens.append("?" if token[0] in "'\"`[" else token.upper())
    for statement in " ".join(tokens).split(";"):
        words = statement.strip()
        if not words:
            continue
        # Explicitly additive forms only. Triggers (including nested DELETE),
        # table rebuilds, writes to existing data and unfamiliar forms need review.
        if re.match(r"CREATE (?:UNIQUE )?(?:TABLE|INDEX|VIEW)\b", words):
            if "ON CONFLICT REPLACE" not in words:
                continue
        if re.match(r"ALTER TABLE (?:[\w$]+|\?) ADD\b", words):
            continue
        return True
    return False


def main(root, tag, directory):
    diff = subprocess.check_output([
        "git", "-C", root, "diff", "--name-only", "-z", "--no-renames",
        "--diff-filter=A", tag, "HEAD", "--", directory + "/*.sql",
    ])
    for path in filter(None, diff.decode().split("\0")):
        sql = subprocess.check_output(["git", "-C", root, "show", "HEAD:" + path]).decode()
        if sql.split("\n", 1)[0] == "-- oa:non-additive":
            if not re.search(r"^-- oa:verify[ \t]+\S", sql, re.MULTILINE):
                sys.exit(f"{path}: describe the verification plan in a -- oa:verify comment")
        elif needs_review(sql):
            sys.exit(f"{path}: destructive or unclassified SQL requires -- oa:non-additive on line 1 and a verification plan")


if __name__ == "__main__":
    main(*sys.argv[1:])
