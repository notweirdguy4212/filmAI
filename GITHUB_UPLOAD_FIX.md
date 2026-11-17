# GitHub upload fix

The NextAuth catch-all route is intentionally located at:

`src/app/api/auth/[...nextauth]/route.ts`

Do **not** rename `[...nextauth]`. Square brackets are valid Git path characters and are required by the Next.js App Router for this catch-all route. The route has been verified as addable to Git's index with:

```bash
git add -- "src/app/api/auth/[...nextauth]/route.ts"
```

If a GitHub upload tool reports `Invalid Git path`, it is rejecting/encoding the path incorrectly; it is not a malformed Next.js route. Upload the extracted project with Git CLI instead of that tool's single-file/path upload flow:

- macOS/Linux: `./upload-to-github.sh https://github.com/OWNER/REPOSITORY.git`
- Windows PowerShell: `./upload-to-github.ps1 -RemoteUrl https://github.com/OWNER/REPOSITORY.git`

Run the command from the extracted `filmAI-Studio` project directory. The scripts stage the repository using `git add -A`, commit staged files, and push the current branch to `origin`. GitHub authentication is handled by your configured Git credential manager or SSH setup.

Before pushing, confirm that no real `.env` files, API keys, credentials, or private assets are present. `.env` files are ignored by the repository's `.gitignore`; `.env.example` is safe to commit only if it contains placeholders.
