# V-Login

## Architektur & Technologie

Unsere Lösung basiert auf **browserless**, einem Docker-Container, der einen voll funktionsfähigen Headless-Browser (NSTChrome) bereitstellt und über einen WebSocket-Endpunkt zugänglich ist. Anstatt für jede Anfrage einen neuen Browser zu starten, verwaltet Browserless effizient mehrere Browser-Sitzungen und aktiviert nur die erforderlichen Instanzen "on demand".

### Wie funktioniert Browserless?

-   **Remote DevTools & WebSocket API:** Browserless bietet eine API, die über WebSockets zugänglich ist. Dies ermöglicht die Fernsteuerung des Browsers mithilfe des Chrome DevTools Protocol. Unsere Anwendung verbindet sich mit diesem Endpunkt, um eine Browser-Sitzung zu starten und diese für automatisierte Aufgaben zu nutzen.
-   **Effiziente Sitzungsverwaltung:** Anstatt für jede einzelne Anfrage einen vollständigen Browser zu starten, verwaltet Browserless intern Browser-Sitzungen. Dies schont Ressourcen und ermöglicht ein schnelles, skalierbares Automatisierungs-Setup.
-   **Validierte Fingerabdrücke:** Das nstbrowser-Projekt enthält eine Datenbank gültiger Fingerabdrücke und weiß, wie diese verschleiert werden müssen. Dadurch wird sichergestellt, dass automatisierte Prozesse so menschenähnlich wie möglich erscheinen und die Wahrscheinlichkeit, blockiert zu werden (z. B. von Imperva), minimiert wird.

### Warum ist das ideal für Automation?

-   **Ressourcenschonend:** Da Browserless mehrere Sitzungen innerhalb eines einzigen Containers verwaltet, werden Ressourcen effizient genutzt und es müssen nicht für jede Anfrage separate Browser-Instanzen gestartet werden.
-   **Schnelle Antwortzeiten:** Die Verwendung der WebSocket-API ermöglicht eine nahezu sofortige Steuerung des Browsers, was in Kombination mit optimierten Fingerabdrücken zu schnellen und zuverlässigen Automatisierungen führt.
-   **Flexibilität und Skalierbarkeit:** Die modulare Architektur ermöglicht die einfache Integration zusätzlicher Workflows (z. B. dynamische Fingerabdrücke und IP-Verwaltung). Dadurch eignet sich das System gut für komplexe Automatisierungsszenarien.

Diese Architektur macht unsere Lösung besonders leistungsstark - ideal für automatisierte Authentifizierungen, Datenextraktion und andere Aufgaben, die zuverlässige Browser-Interaktionen erfordern.

## Voraussetzungen

Stelle sicher, dass die folgenden Voraussetzungen auf deinem System erfüllt sind:

-   Node.js (empfohlen: die neueste LTS-Version)
-   Docker

## Installation

Folge diesen Schritten in der angegebenen Reihenfolge, um die Anwendung zu installieren und auszuführen:

### 1. pnpm installieren

```bash
npm install -g pnpm@latest-10
