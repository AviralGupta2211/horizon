#!/bin/sh
# Publishes the website.
#
# GitHub Pages serves the gh-pages branch. This puts onto that branch only the files the page itself
# needs, taken from the commit you are on, and pushes it. Tests, tools and the README stay off the
# site, so nothing else is served from the address where people keep their Claude key.
#
# Run from the repository root, on a commit that is already pushed:   sh tools/publish-site.sh
set -eu

SITE="index.html css js fonts icons manifest.webmanifest .nojekyll"
REMOTE="${REMOTE:-origin}"

cd "$(git rev-parse --show-toplevel)"
if [ -n "$(git status --porcelain)" ]; then echo "There are uncommitted changes. Commit them first, so the site matches a commit." >&2; exit 1; fi
src=$(git rev-parse --short HEAD)

# Build the tree in a throwaway index, so the files you are working on are not touched.
GIT_INDEX_FILE=$(mktemp); export GIT_INDEX_FILE
trap 'rm -f "$GIT_INDEX_FILE"' EXIT
git read-tree --empty
# shellcheck disable=SC2086
git ls-tree -r HEAD -- $SITE | git update-index --index-info
tree=$(git write-tree)

git fetch -q "$REMOTE" gh-pages 2>/dev/null && parent=$(git rev-parse -q --verify FETCH_HEAD) || parent=""
if [ -n "$parent" ] && [ "$(git rev-parse "$parent^{tree}")" = "$tree" ]; then echo "The site already matches $src. Nothing to publish."; exit 0; fi

msg="Publish the site from $src"
if [ -n "${PUBLISH_NOTE:-}" ]; then msg="$msg

$PUBLISH_NOTE"; fi
if [ -n "$parent" ]; then commit=$(git commit-tree "$tree" -p "$parent" -m "$msg"); else commit=$(git commit-tree "$tree" -m "$msg"); fi

git push "$REMOTE" "$commit:refs/heads/gh-pages"
echo "Published $src. GitHub takes a minute or two to put it live."
