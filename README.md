# Lampas Launcher

The one-click way to play the Lampas SMP Minecraft server. The launcher keeps your mods in step with the server, sets up Java for you, and joins the server when you press **Play**.

**Download:** [Microsoft Store](https://apps.microsoft.com/detail/9P9WWSV7L7RS?mode=direct) (Windows) · [GitHub Releases](https://github.com/justbecauseph/lampas-launcher/releases/latest) (Windows and Linux)

---

## What it does

- **Browser sign-in:** log in through the Lampas Portal in your browser.
- **Automatic mod updates:** before the game starts, the launcher downloads the server's current mods, configs and resource packs, so you always match the server.
- **Java included:** Minecraft 26.2 needs Java 25. If you don't have it, the launcher downloads Mojang's Java runtime for you.
- **Straight into the server:** press **Play** and the game joins Lampas, with no server address to type.
- **Required resource packs:** the server's resource packs are downloaded and switched on for you. Your own packs stay as they are.
- **Your own mods and shaders:** drop extra mods (`.jar`) or shader packs (`.zip`) into the **Client mods** tab, and switch optional pack mods on or off.
- **Server status:** see whether the server is online and who is playing before you launch.
- **Move your game folder:** move the game to another drive from Settings.
- **Repair:** if the game acts up, Repair checks every file against the server's copy and replaces anything damaged.

## Install and play

1. **Get the launcher.**
   - **Windows:** install it from the [Microsoft Store](https://apps.microsoft.com/detail/9P9WWSV7L7RS?mode=direct). The Store keeps it up to date.
   - **Windows without the Store:** download `LampasLauncher-Setup-<version>.exe` (installer) or `LampasLauncher-<version>-Windows.exe` (portable) from [GitHub Releases](https://github.com/justbecauseph/lampas-launcher/releases/latest). The launcher tells you when a newer version is out.
   - **Linux:** download `LampasLauncher-<version>-Linux.AppImage` (make it executable, then run it) or the `.tar.gz` from [GitHub Releases](https://github.com/justbecauseph/lampas-launcher/releases/latest).
2. **Choose a game folder.** The first time you open the launcher, it asks where to install Minecraft. The suggested folder is fine for most people.
3. **Log in.** Click **Log in**. Your browser opens the Lampas Portal; sign in and link your Minecraft account there.
4. **Press Play.** The launcher updates the mods, prepares Java and starts Minecraft.

## Launcher tour

| Tab                | What it's for                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Play**           | Server status and who's online, the **Play** button, and **Stop** while the game runs.                                                              |
| **Client mods**    | Switch optional mods on or off, add your own mods and shader packs, and **Repair pack**.                                                            |
| **Console & logs** | Live game output while Minecraft runs. **Copy** it for staff, or open the launcher log or Minecraft log.                                            |
| **Settings**       | Memory (2–16 GB, 8 GB by default), release channel (Stable, Beta, Dev), game folder, **Repair game files**, **Remove game files** and Java options. |

## FAQ

### "It says my Minecraft account isn't linked."

Open the [Lampas Portal](https://dev.lampas.town), link your Minecraft Java account to your profile, then log in to the launcher again.

### "It says Minecraft sign-in is required."

The launcher only starts Minecraft for an account that owns Minecraft: Java Edition. On the [Lampas Portal](https://dev.lampas.town), link the Microsoft account you bought Minecraft with, then log in to the launcher again.

### "It says a launcher update is required."

The server's current pack needs a newer launcher. Microsoft Store installs update through the Store; other installs download the latest release from GitHub.

### "My game crashed or won't start."

1. Click **Repair & retry** under the error, or **Repair game files** in Settings. This checks every file and replaces anything broken.
2. If it still fails, open **Console & logs**, click **Copy**, and send the output to the Lampas staff on Discord.

### "Will updates delete my worlds, screenshots or settings?"

No. Updates never replace your worlds, screenshots, logs, game options or server list. If you don't have game options or a server list yet, the launcher gives you the pack's starting copies. In your game options, the launcher only keeps the server's resource packs switched on, and the pack can change a specific key binding once (for example the map key); after that, you can change it back.

**Remove game files** in Settings is different: it deletes the game folder, including your worlds, after asking you to confirm.

### "Where are my game files with the Microsoft Store version?"

By default, in the launcher's own storage, shown as **Launcher storage** at the bottom of the Play tab. Windows deletes that storage, including your worlds, when you uninstall the launcher. To keep your files after an uninstall, choose another folder during setup or move the game folder in Settings, for example to another drive.

### "Does closing the launcher close Minecraft?"

No. Minecraft keeps running, and the launcher reconnects to it when you reopen it. To end the game from the launcher, press **Stop**; this closes Minecraft right away, so save your world first.

## Privacy and security

- [Privacy notice](PRIVACY.md): what the launcher stores and shares.
- [Security](SECURITY.md): how the launcher protects your account and files, and how to report a problem.

## For developers

Build steps, release process and internals are in [ARCHITECTURE.md](ARCHITECTURE.md).

## License

The source code is licensed under the [Apache License 2.0](LICENSE). Lampas names, logos and artwork are not covered by that license and are reserved by the Lampas SMP team. Minecraft, mods, resource packs and other game assets belong to their respective owners.

NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.
