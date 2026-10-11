# gh-dash contributor guidance

## Shared UI kit

`web/src/workbench` is a pinned shared workbench-ui snapshot. Never edit it in
place. Fix the kit, commit the changes there, then re-vendor with the kit's
`scripts/vendor.mjs`. `npm run check:workbench` verifies the copy; typecheck and
build commands also run this check. Keep product code and styles outside the
vendored directory. Preserve the snapshot's `VENDORED.md`, `VENDORED.json`,
`verify-vendor.mjs`, and `.gitattributes` together.

## Changelog

`CHANGELOG.md` at the root. Every pull request adds one concise line under
`## Unreleased`, ending with its link, e.g.
`([#24](https://github.com/kcosr/gh-dash/pull/24))`: open the pull request
first, then commit the line once its number is known. Group the lines under
`### Breaking changes`, `### Added`, `### Changed` and `### Fixed`, adding a
heading only when it has a line, and appending to an existing one. Never edit a
released version's section.

## Releases

Semantic versions, 0.x for now. To release:

1. On a branch, rename `## Unreleased` to `## <version> - <YYYY-MM-DD>`, add a
   new empty `## Unreleased` above it, and set `version` in `package.json` (and
   `package-lock.json`) to match. Merge that through a pull request.
2. On the merged commit of `main`, create an annotated tag `v<version>` and
   push it.
3. Create the GitHub release for the tag, titled `v<version>`, with that
   version's changelog section as its notes. Nothing is attached: the desktop
   installers are unsigned (README, "Desktop app").
