# ModLoom

Windows-App zum Installieren von Fabric und zum Verwalten von Modrinth-Mods in Listen.

## Herunterladen

Immer die neueste Fassung, ohne GitHub-Konto:

| Datei | Zweck |
| --- | --- |
| [**Setup**](https://github.com/alessioStz/MCMod/releases/latest/download/ModLoom-Setup.exe) | Installation mit Startmenü-Eintrag, **hält sich selbst aktuell** |
| [**Portable**](https://github.com/alessioStz/MCMod/releases/latest/download/ModLoom-Portable.exe) | Startet direkt, keine Installation |

Die beiden Links zeigen immer auf die neueste Fassung und bleiben gültig — einmal
weitergeben genügt. Alle Fassungen: [Releases](https://github.com/alessioStz/MCMod/releases)

Die portable Fassung entpackt sich bei jedem Start selbst und braucht dafür rund 7 bis 10
Sekunden, bis das Fenster erscheint; beim ersten Mal länger, weil Windows die Datei prüft.
Die Setup-Fassung startet sofort.

Beide sind unsigniert — Windows SmartScreen meldet sich beim ersten Start einmal
("Weitere Informationen" → "Trotzdem ausführen").

Voraussetzung: Windows 10/11 (64 Bit) und ein vorhandener Minecraft-Ordner.

## Was die App macht

**Fabric** – Alle von Fabric unterstützten Minecraft-Versionen (Snapshots per Schalter),
dazu die passenden Loader-Versionen. „Installieren & aktivieren“ schreibt
`versions/fabric-loader-<loader>-<mc>/` in den Minecraft-Ordner und trägt ein Profil in
`launcher_profiles.json` ein — genau wie der offizielle Fabric-Installer im Client-Modus.
Das Profil steht danach im normalen Minecraft-Launcher zur Auswahl.

**Mods suchen** – Modrinth-Suche mit Mod-Icon, Autor, Downloadzahl und Kategorien,
gefiltert auf Fabric und die aktive Minecraft-Version. Sortierung nach Relevanz,
Beliebtheit oder Aktualität; Nachladen beim Scrollen. Ein Klick installiert direkt in
`<Minecraft-Ordner>/mods`, inklusive SHA1-Prüfung der heruntergeladenen Datei.

**Listen** – Beliebig viele Mod-Listen. Listen speichern Projekte, keine festen
Dateiversionen: beim Installieren sucht ModLoom für jeden Eintrag die Version, die zur
gerade aktiven Minecraft-Version passt. Export als `.modlist.json`, Import per Dialog —
so installiert eine ganze Gruppe dasselbe Set, ohne dass jemand einzeln suchen muss.

**Fehlende Versionen** – Gibt es eine Mod für die aktive Minecraft-Version nicht, wird sie
**markiert und übersprungen**, nie ersatzweise installiert. In der Listenansicht steht das
als Hinweis an der Zeile, nach dem Installieren im Ergebnisdialog unter „Nicht verfügbar“.
Die Mod bleibt in der Liste und wird beim nächsten passenden Minecraft-Update wieder
mitgezogen.

**Versionswechsel** – Wechselt man die Minecraft-Version, während Mods im Ordner liegen,
fragt ModLoom vorher: als Liste sichern und wechseln, ohne sichern wechseln, oder
abbrechen. Erst danach wird der `mods`-Ordner geleert und Fabric installiert. Direkt im
Anschluss bietet die App an, die gesicherte Liste für die neue Version neu zu installieren.

**Abhängigkeiten** – Pflicht-Abhängigkeiten (z. B. Fabric API) werden automatisch
mitinstalliert und in der Übersicht als solche gekennzeichnet. Abschaltbar in den
Einstellungen.

## Updates

Die **Setup-Fassung** sucht beim Start still nach einer neueren Version. Gibt es eine,
erscheint ein ruhiger Hinweis unten in der Seitenleiste; heruntergeladen und eingespielt
wird erst nach Zustimmung. Das Einspielen passiert beim nächsten Start, Listen und
Einstellungen bleiben erhalten. Von Hand suchen lässt sich unter *Einstellungen*.

Die **portable Fassung** kann sich bauartbedingt nicht selbst ersetzen. Sie meldet nur,
dass eine neue Version da ist, und öffnet auf Wunsch die Download-Seite — die neue
`ModLoom-Portable.exe` ersetzt dann einfach die alte.

Grundlage ist `latest.yml` im GitHub-Release, das der Build-Workflow automatisch mitlegt.

## Sicherheitsnetz

Entfernte Dateien wandern in den **Papierkorb**, nicht in den endgültigen Nirwana — ein
versehentlicher Wechsel lässt sich zurückholen. Fremde `.jar`-Dateien, die ModLoom nicht
selbst installiert hat, werden als solche ausgewiesen; ob sie beim Wechsel mit entfernt
werden, entscheidet eine Checkbox im Dialog.

## Speicherorte

| Was | Wo |
| --- | --- |
| Minecraft-Ordner (Vorgabe) | `%APPDATA%\.minecraft` — in den Einstellungen änderbar |
| Mods | `<Minecraft-Ordner>\mods` |
| Verwaltungsdaten der Mods | `<Minecraft-Ordner>\mods\.modloom.json` |
| Listen & Einstellungen | `%APPDATA%\ModLoom\config.json` |
| Fehlerprotokoll | `%APPDATA%\ModLoom\modloom.log` (bei jedem Start neu) |

Ein anderer Minecraft-Ordner (Prism, MultiMC, ein zweiter Launcher) lässt sich in den
Einstellungen setzen — es muss nur der Ordner sein, der `mods` und `versions` enthält.

## Aus dem Quelltext bauen

```bash
npm install
npm start          # Entwicklungsstart
npm run dist       # baut Setup + Portable nach dist/
```

Getestet mit Node 22 und Electron 33.

> Läuft der Build in einer VS-Code-Umgebung, muss `ELECTRON_RUN_AS_NODE` vorher aus der
> Umgebung entfernt werden — sonst startet Electron als reines Node ohne Fenster.

## Aufbau

```
src/main/     Node-Seite: main.js (Fenster + IPC), fabric.js, modrinth.js,
              mods.js (Installation/Manifest), store.js (Listen), net.js (Download + SHA1),
              updater.js (Updates aus den GitHub-Releases)
src/renderer/ Oberfläche: index.html, styles.css, app.js (Ansichten),
              ui.js (Sheets, Menüs, Toasts), spring.js (Federn)
```

Der Renderer hat keinen Netzzugriff (CSP `connect-src 'none'`); alle API-Aufrufe laufen
über IPC im Main-Prozess. Mod-Icons kommen direkt von `cdn.modrinth.com`.

## Bewegung und Gestaltung

Die Oberfläche folgt dem `apple-design`-Skill: Federn statt fester Animationsdauern
(`spring.js`, Apples Modell aus Dämpfungsgrad + Response), Rückmeldung schon beim
Drücken, Dialoge lassen sich am Griff 1:1 nach unten ziehen und mit Schwung wegwerfen
(Momentum-Projektion, weiche Grenze nach oben), durchscheinende Materialien für
Seitenleiste und Toolbar, größenabhängiges Tracking in der Typografie. `prefers-reduced-motion`,
`prefers-reduced-transparency` und `prefers-contrast` sind berücksichtigt, Hell und
Dunkel folgen dem System.

## Datenquellen

- Fabric-Versionen: `meta.fabricmc.net`
- Mods: `api.modrinth.com` (v2)
