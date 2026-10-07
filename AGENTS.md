# gh-dash contributor guidance

## Shared UI kit

`web/src/workbench` is a pinned shared workbench-ui snapshot. Never edit it in
place. Fix the kit, commit the changes there, then re-vendor with the kit's
`scripts/vendor.mjs`. `npm run check:workbench` verifies the copy; typecheck and
build commands also run this check. Keep product code and styles outside the
vendored directory. Preserve the snapshot's `VENDORED.md`, `VENDORED.json`,
`verify-vendor.mjs`, and `.gitattributes` together.
