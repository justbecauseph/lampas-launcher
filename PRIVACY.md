# Your privacy in Lampas Launcher

This notice explains what Lampas Launcher stores on your computer and shares when you use it. Minecraft and individual mods may collect or share information separately.

## What connects to the internet

The launcher contacts Lampas Portal to sign you in, refresh your session, check pack versions and show server status. Signing in opens your browser and returns the result to the launcher on your computer.

Installing or repairing a pack also downloads files from Minecraft, Fabric and approved pack download providers. Those providers can see your IP address, which files you request and when you request them. Public file downloads do not receive your Lampas Portal credentials or cookies.

Copies installed from GitHub Releases check GitHub every few hours for a newer launcher version. GitHub can see your IP address and when the check happens; the request carries no account information. Copies installed from the Microsoft Store skip this check because the Store delivers updates.

**External avatars and mod images are on by default.** You can turn them off in Settings; the launcher then uses initials and placeholders. While they are enabled, image providers receive your IP address and request timing; the avatar provider also receives your Minecraft username or account identifier. The launcher temporarily caches these images in memory. Disabling the setting or logging out clears that cache and cancels pending requests.

## What stays on your computer

The launcher stores settings and saved sign-ins in its application data folder, separately from your game files. Settings are saved in `config.json`; protected sign-ins are saved in `credentials.enc`.

Windows protects saved sign-ins through the operating system. Linux uses the system keyring when it is available. If protected storage reports that it cannot be used, your sign-in stays in memory for that session and is lost when you exit. The launcher does not save an unprotected copy instead.

A locked Linux keyring may show a system unlock prompt. You may need to unlock the keyring before the launcher can continue.

## Logs and diagnostics

Launcher logs stay in the application's `logs` folder. There is no automatic diagnostic upload. The launcher keeps up to three log files, each limited to about 5 MB, and removes files older than seven days when it starts or rotates its logs.

Logs record events such as update results and connection failures. Normal logging omits account profiles, settings values and request or response bodies. The launcher removes recognized credentials and sensitive URL details before displaying or saving messages, and drops excessively long process-output lines.

This filtering cannot recognize every possible secret or everything a mod might print. Check logs before sharing them. Minecraft and mod logs, crash reports, saves and screenshots have separate storage and are not deleted by the launcher's log cleanup. Mods may also make their own network requests.

## Logging out and upgrading

Logging out removes the launcher's active session and saved credentials, clears account information from the interface and clears cached external images. A pending sign-in or refresh cannot restore the session afterward. Your non-sensitive settings remain.

Logging out does not close a running Minecraft session or clear your browser's cookies. Minecraft needs an access token to start, and software running as your operating-system user may be able to read that live session information.

When upgrading from older versions, the launcher removes old, unprotected sign-in records and asks you to sign in again. Copies in old backups are not removed automatically.

For security concerns or help with recovery, see [Security](SECURITY.md).
