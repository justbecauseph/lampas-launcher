# Staying safe with Lampas Launcher

Lampas Launcher supports Windows and Linux. This page explains how it protects your account and game files, what to do when something goes wrong, and how to report a security problem.

## Your account

The launcher sends your sign-in credentials only to an approved Lampas Portal service. Download servers do not receive those credentials. Changing the Portal address clears the previous session and requires you to sign in again.

Saved sign-ins use your operating system's protected storage. If that storage is unavailable, the launcher keeps your sign-in only for the current session instead of saving it as plain text. Linux may ask you to unlock your system keyring.

An upgrade from an older launcher may ask you to sign in again while removing old, unprotected credentials. See [Privacy](PRIVACY.md) for details about stored information and logging out.

## Your game files

The launcher checks pack information and downloaded files before applying updates. General pack updates cannot overwrite saves, screenshots, Minecraft logs, crash reports, personal options or server lists. Changes to selected configuration files require an explicit pack configuration rule. Imported mods are tracked separately from managed pack files.

Keep backups of worlds and other files you care about. Mods and a Java installation you choose yourself run code on your computer. Only use sources you trust: matching a download's checksum does not prove that its publisher or code is safe.

## If an update, repair or move fails

If the launcher detects damaged files, invalid pack information or an interrupted repair, it may block launching until the problem is resolved. Run **Repair** after fixing the reported cause. Repair checks the managed game files and runtime before clearing an integrity block; a quick sync is not a full integrity check.

A block caused by the Portal refusing access (for example a revoked release or an account that is no longer allowed on a channel) is recorded per game folder and stays in place after signing out or switching accounts. Run **Repair** once the account and channel are allowed again; a successful full repair clears it.

If a directory move needs recovery, keep both the original and destination folders until recovery is resolved. Do not delete recovery records or install an older launcher just to bypass a security error. Ask the maintainers for help if the launcher cannot recover safely.

## Report a security problem

Contact the Lampas maintainers through an established private channel. Include your launcher version, operating system, what happened and steps to reproduce it with a test account or harmless sample files where possible.

Do not post passwords, access tokens, account files or unreviewed logs in a public issue. Review any diagnostic files before sharing them.

The launcher cannot protect a live account from malware already running as your operating-system user. It also cannot make arbitrary mods or a compromised download provider trustworthy.
