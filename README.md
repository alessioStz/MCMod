# ModLoom

Windows-App zum Installieren von Fabric und zum Verwalten von Modrinth-Mods in Listen.

## Fertige Programme

Nach dem Build liegen sie in `dist/`:

| Datei | Zweck |
| --- | --- |
| `ModLoom-1.0.0-portable.exe` | Startet direkt, keine Installation |
| `ModLoom-1.0.0-Setup.exe` | Installer mit Startmenü-Eintrag, Zielordner frei wählbar |

Beide sind unsigniert — Windows SmartScreen meldet sich beim ersten Start einmal
("Weitere Informationen" → "Trotzdem ausführen").

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
              mods.js (Installation/Manifest), store.js (Listen), net.js (Download + SHA1)
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
