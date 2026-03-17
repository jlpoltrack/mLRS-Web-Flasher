# Migration Plan — mLRS Web Flasher
<!-- 2026-03-17 -->
<!-- updated: 2026-03-17 -->

Moving the mLRS-Flasher web application to a new repository named **mLRS-Web-Flasher**. This document
covers every touchpoint that needs updating: build config, CI/CD workflows, GitHub repo settings,
and git operations.

---

## 1. Create the New Repository

- [ ] Create new repo: `jlpoltrack/mLRS-Web-Flasher`
- [ ] Set visibility (public/private) and default branch to `main`
- [ ] Copy the LICENSE (GPLv3) file as-is — no changes needed

## 2. GitHub Repository Settings

### Secrets & Environments
- [ ] Create environment: `prod`
- [ ] Add repository secrets: `FTP_USERNAME`, `FTP_PASSWORD`, `FTP_SERVER`

### GitHub Pages (configure after first push — the `gh-pages` branch is auto-created by the workflow)
- [ ] Enable GitHub Pages (Settings → Pages)
- [ ] Set source to `gh-pages` branch, root (`/`)
- [ ] Confirm the published URL: `https://jlpoltrack.github.io/mLRS-Web-Flasher/`

### Repository Features
- [ ] Enable Issues (if tracking bugs/features here)
- [ ] Enable Discussions (optional)
- [ ] Set repository description and topics (`mlrs`, `flasher`, `web-serial`, etc.)

## 3. Build Configuration

### `web/vite.config.ts`
- Line 7: `base: process.env.VITE_BASE_PATH || '/mLRS-Flasher/'`
  - **Must update** fallback to `'/mLRS-Web-Flasher/'`

### `web/public/.htaccess`
- Lines 4, 8: `RewriteBase /mlrs/flash/` and fallback path
  - Update only if the FTP deployment path changes

## 4. GitHub Actions Workflows

### `.github/workflows/gh-pages-deploy.yml`
- Lines 38, 41: hardcoded `BASE_PATH=/mLRS-Flasher/`
  - **Must update** to `/mLRS-Web-Flasher/`
- Uses `secrets.GITHUB_TOKEN` (auto-provided, no setup needed)
- Uses `peaceiris/actions-gh-pages@v3` with `keep_files: true`
  - Branch preview feature deploys non-main branches to subdirectories

### `.github/workflows/ftp-deploy.yml`
- Line 30: `VITE_BASE_PATH=/mlrs/flash/` — update if the FTP path changes
- Requires the secrets and `prod` environment configured in step 2

## 5. Git Operations

```bash
git remote set-url origin https://github.com/jlpoltrack/mLRS-Web-Flasher.git
git push origin main
```

## 6. Content to Migrate

- `web/` — the entire Vite+React application (primary deliverable)
- `docs/` — architecture documentation and this migration plan
- `.github/workflows/` — CI/CD pipelines
- `CLAUDE.md` — AI assistant project guide
- `LICENSE` — GPLv3
- `README.md`
- `.gitignore`

### Content to Exclude (optional)
- `z_archive/` — legacy Python/Electron code (88KB+ Python script, thirdparty deps)
  - Can be excluded if starting fresh, or kept for historical reference
- `web/node_modules/` and `web/dist/` — already gitignored

## 7. Post-Migration Verification

- [ ] Clone the new repo from scratch
- [ ] Run `cd web && npm install && npm run build` — verify clean build
- [ ] Run `npm run dev` — verify local dev server works
- [ ] Push a commit to `main` — verify GitHub Pages deployment triggers
- [ ] Push a commit to `main` — verify FTP deployment triggers
- [ ] Push a commit to a feature branch — verify branch preview deploys
- [ ] Load the deployed site and test a firmware version fetch (GitHub API calls)

## 8. Old Repository Cleanup

- [ ] Update `jlpoltrack/mLRS-Flasher` README to point to new location
- [ ] Archive the old repo (Settings → Archive) or add a deprecation notice
- [ ] Update any external links (wiki pages, forum posts, etc.)
