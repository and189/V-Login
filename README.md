# V-Login

## Architektur & Technologie

Unsere Lösung basiert auf **browserless**, einem Docker-Container, der einen voll funktionsfähigen Headless-Browser (NSTChrome) bereitstellt und über einen WebSocket-Endpunkt zugänglich ist. Anstatt für jede Anfrage einen neuen Browser zu starten, verwaltet browserless effizient mehrere Browser-Sitzungen, sodass nur die notwendigen Instanzen "on demand" aktiviert werden.

### Wie funktioniert Browserless?

-   **Remote DevTools & WebSocket API:**
    Browserless bietet eine API, die über WebSockets zugänglich ist. Dies ermöglicht die Fernsteuerung des Browsers über das Chrome DevTools Protocol. Unsere Anwendung verbindet sich mit diesem Endpunkt, um eine Browser-Sitzung zu starten und für automatisierte Aufgaben zu nutzen.

-   **Effiziente Sitzungsverwaltung:**
    Anstatt für jede einzelne Anfrage einen kompletten Browser zu starten, verwaltet browserless Browser-Sitzungen intern. Dies spart Ressourcen und ermöglicht eine schnelle, skalierbare Automatisierungseinrichtung.

-   **Validierte Fingerprints:**
    Das nstbrowser-Projekt enthält eine Datenbank mit validen Fingerprints und weiß, wie diese verschleiert werden. Dies stellt sicher, dass automatisierte Prozesse so menschenähnlich wie möglich erscheinen und die Wahrscheinlichkeit, blockiert zu werden (z. B. durch Imperva), minimiert wird.

### Warum ist das ideal für die Automatisierung?

-   **Ressourceneffizient:**
    Da browserless mehrere Sitzungen innerhalb eines einzelnen Containers verwaltet, werden Ressourcen effizient genutzt und es müssen nicht für jede Anfrage separate Browser-Instanzen gestartet werden.

-   **Schnelle Reaktionszeiten:**
    Die Verwendung der WebSocket-API ermöglicht eine nahezu sofortige Steuerung des Browsers, was in Kombination mit optimierten Fingerprints zu schnellen und zuverlässigen Automatisierungen führt.

-   **Flexibilität und Skalierbarkeit:**
    Die modulare Architektur ermöglicht die einfache Integration zusätzlicher Workflows (z. B. dynamisches Fingerprinting und IP-Management). Dies macht das System gut geeignet für komplexe Automatisierungsszenarien.

Diese Architektur macht unsere Lösung besonders leistungsstark – ideal für automatisierte Authentifizierungen, Datenextraktionen und andere Aufgaben, die zuverlässige Browser-Interaktionen erfordern.

## Voraussetzungen

Stellen Sie sicher, dass die folgenden Voraussetzungen auf Ihrem System erfüllt sind:

-   Node.js (empfohlen: die neueste LTS-Version)
-   Docker

## Installation

Führen Sie die folgenden Schritte in der angegebenen Reihenfolge aus, um die Anwendung zu installieren und auszuführen:

1.  **pnpm installieren**

    ```bash
    npm install -g pnpm@latest-10
    ```

2.  **Abhängigkeiten installieren**

    ```bash
    pnpm install
    ```

3.  **Den Browserless Docker-Container starten**

    Ersetzen Sie die Werte für `TOKEN` und `PORT` bei Bedarf:

    ```bash
    sudo docker run -it -e TOKEN=110e2d21-efc4-44e5-853a-9ce4099c81e1 -e PORT=8848 -p 8848:8848 --name browserless nstbrowser/browserless:130-202411051500.v2
    ```

    * Dieser Container ist erforderlich, um Chrome/Puppeteer-Instanzen über einen WebSocket-Endpunkt bereitzustellen.

4.  **Das V-Login Docker-Image erstellen**

    ```bash
    sudo docker build -t v-login .
    ```

5.  **Den V-Login Docker-Container starten**

    Dieser Befehl führt den Container im Host-Netzwerk aus und entfernt ihn automatisch, wenn er stoppt:

    ```bash
    sudo docker run --rm --network="host" v-login
    ```
