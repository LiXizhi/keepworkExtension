# World instructions and documentation

At every task start and world switch, obtain the current identity and call
`world_files` with `{operation:"read",path:"AGENTS.md",expectedIdentity}`.
Read the relevant links before touching scene content. If missing, read-only
analysis may continue without writes. Before editing call `world_docs` with
`{operation:"init",expectedIdentity}`, then read AGENTS.md and docs/README.md back.
Require capabilities `worldDocuments` and `worldAnalysis`; if absent report the
missing engine capability rather than claiming this workflow succeeded.

Initialization preserves existing content. It adds managed sections to AGENTS.md
and docs/README.md, codeblocks.md, movies.md, signs.md, modules.md, changes.md.
All are directly under the world's docs directory. Use additional flat files such
as docs/movie-opening.md only when detail warrants them. Never create a second
copy of existing world instructions elsewhere.

For each changed page, read the full current text with world_files. Call:

```js
{action:"world_docs", clientId, params:{operation:"update",expectedIdentity,
 files:[{path:"docs/movies.md",expectedContent:fullTextFromRead,
         content:completeUpdatedManagedSection}]}}
```

`content` replaces only the marked managed section; omit marker strings. Preserve
its still-relevant facts when composing the replacement. Unmarked user content
is retained. To create a new page use `create:true` and omit expectedContent after
confirming it is absent. Each file is an independent checked write; examine all
returned file statuses. On conflict or timeout read back first, then retry only
missing document changes. Never repeat scene edits to repair documentation.

Keep AGENTS.md short: world conventions, navigation, entry points, resumption rules.
Keep object details in docs. Record type, name, absolute block coordinates,
source/mirror files, fingerprints, module origins, movie and code associations,
verification and remaining work. Runtime reference tokens expire across sessions;
they are not persistent object identities.

When code blocks or signs are numerous, keep docs/codeblocks.md and docs/signs.md
as grouped summaries with counts, responsibilities, entry points and unresolved
items. Avoid a source dump or one long row per object. Link detailed notes for
edited or important objects as docs/codeblock-name.md or docs/sign-name.md, still
directly under docs/. Keep coordinates, paths and fingerprints in those notes so
summarization does not prevent later relocation. State analysis coverage and the
observation date; a few examples must not imply every object's content was read.

In docs/changes.md use the original request/job ID as each edit's unique label.
Merge into an existing entry when recovering; never append a duplicate. Record
purpose, affected objects, actual changes, verification and three separate states:
documentation persisted, runtime edited, native world saved. `world_docs` always
returns `worldSaved:false`: it never saves native blocks. Record a verified native
save separately only after the user requested it and the operation succeeded.

On resume, compare saved/native objects with the recorded fingerprints. Missing
unsaved changes are unresolved history, not a reason to replay the old generator.
Refresh stale descriptions from evidence before modifying the target. Third-party
read-only code remains read-only; for disk mirrors inspect and edit the actual
source through the normal file workflow rather than the virtual code-block file.
