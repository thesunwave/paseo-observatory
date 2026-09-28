# Releasing Paseo Observatory

Observatory is distributed from GitHub first. npm publication is intentionally out of scope for the initial public release.

## Before making the repository public

1. Ensure `main` is clean and contains the intended release candidate.
2. Confirm `package.json` and `paseo-plugin.json` still declare the intended `0.1.0` / Paseo compatibility.
3. Run the release checks:

   ```bash
   npm install
   npm run release:check
   ```

4. Review `README.md`, `SECURITY.md`, `LICENSE` and `docs/ARCHITECTURE.md` for release-accurate claims.
5. Capture fresh screenshots after the final UI build if you plan to list Observatory in `paseo.cafe`. Do not publish screenshots containing private workspace names, prompts, paths, credentials or tool output.

## Make the repository public

Change `thesunwave/paseo-observatory` from private to public in GitHub repository settings.

Do not remove `"private": true` from `package.json` for the GitHub-only release. That field prevents accidental npm publication and does not prevent Paseo from installing the Git repository.

## Clean Git-source smoke test

After the repository is public, validate the exact public distribution path against a disposable Paseo daemon/home rather than the development checkout.

Install from the public Git source:

```bash
paseo plugin add thesunwave/paseo-observatory --ref main
paseo plugin ls observatory
paseo plugin logs observatory
```

Verify at minimum:

- the plugin reaches `running` / `ready` state;
- the Observatory sidebar surface opens on desktop and mobile;
- Live lists known Paseo workspaces/runs;
- Analytics loads without schema/RPC errors;
- one OpenCode or Claude run can be observed without modifying the run;
- the SQLite database is created under the selected Paseo home;
- no preparation/build step or local development dependency is required by the consumer.

Remove the disposable installation after the smoke test.

## Tag the first release

Once the public Git-source smoke test passes:

```bash
git checkout main
git pull --ff-only
git tag -a v0.1.0 -m "Paseo Observatory v0.1.0"
git push origin v0.1.0
```

Create a GitHub Release for `v0.1.0` describing:

- Live workspace/run observability;
- OpenCode rich runtime/session telemetry;
- Claude Code structured timeline/process telemetry;
- global and workspace model analytics;
- local SQLite persistence and privacy boundaries;
- current limitations from `README.md`.

Users who want an explicit initial revision can install the tag:

```bash
paseo plugin add thesunwave/paseo-observatory --ref v0.1.0
```

A normal unpinned install uses the repository's default branch:

```bash
paseo plugin add thesunwave/paseo-observatory
```

## Updates

Git installations can be reviewed and updated with:

```bash
paseo plugin update observatory
```

Paseo resolves the proposed remote revision and asks for approval before activating an update.

## paseo.cafe

After the repository is public and the first release is proven, submit it to the community-run `paseo.cafe` directory.

The catalog requires a public GitHub repository, a `paseo-plugin.json` id matching the registry filename, and a released semantic version in `package.json`. Increment the package version for every cataloged plugin update even while distribution remains Git-only.

An initial registry entry can look like:

```json
{
  "repo": "thesunwave/paseo-observatory",
  "categories": ["monitoring", "productivity"],
  "platforms": ["macos", "linux"],
  "caveats": [
    "Historical telemetry begins when Observatory starts capturing a run",
    "Claude subagents created before Observatory subscribes cannot be backfilled through the public plugin API"
  ],
  "submittedBy": "thesunwave"
}
```

Before submission, add a small set of sanitized screenshots under an `images/` directory so the listing can show the UI. Include caveats for:

- historical telemetry beginning at Observatory's capture boundary;
- Claude historical subagents not being backfilled through the public plugin API;
- Windows rich process telemetry not being claimed for v0.1.0.

`paseo.cafe` is a community directory, not an official review or endorsement by the Paseo project.

## Future npm publication

If npm distribution is added later:

1. choose and verify the final package name;
2. remove `"private": true` intentionally;
3. re-run `npm run release:check`;
4. test installation from the published npm artifact on a disposable Paseo daemon before documenting npm as supported.
