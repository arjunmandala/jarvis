# Vendored ponytail skills

Two skills from the [ponytail plugin](https://github.com/getponytail/ponytail) are vendored here so
`e2b/build-template.ts` can bake them into the sandbox at `/home/user/.claude/skills`
(same mechanism as `vendor/superpowers-skills`):

- `ponytail` — lazy/minimal building discipline (used by the implement agent)
- `ponytail-review` — over-engineering review lens (used by the review agent)

## To (re)populate or update

Copy from a machine with the ponytail plugin installed (adjust the version dir):

```powershell
$src = "$env:USERPROFILE\.claude\plugins\cache\ponytail\ponytail\<version>\skills"
Copy-Item -Recurse -Force "$src\ponytail" vendor\ponytail-skills\ponytail
Copy-Item -Recurse -Force "$src\ponytail-review" vendor\ponytail-skills\ponytail-review
```

Then rebuild the template: `node --env-file-if-exists=.env e2b/build-template.ts`.
Only these two skills are vendored on purpose — the rest of the plugin
(commands, hooks, statusline, other skills) is human-facing and useless in the sandbox.
