# V-Login

## Architecture & Technology

Our solution is based on **browserless**, a Docker container that provides a fully functional headless browser (NSTChrome) and is accessible via a WebSocket endpoint. Instead of launching a new browser for every request, browserless efficiently manages multiple browser sessions, activating only the necessary instances "on demand."

### How Does Browserless Work?

-   **Remote DevTools & WebSocket API:**
    Browserless offers an API accessible via WebSockets. This allows remote control of the browser using the Chrome DevTools Protocol. Our application connects to this endpoint to start a browser session and use it for automated tasks.

-   **Efficient Session Management:**
    Instead of launching a complete browser for every single request, browserless manages browser sessions internally. This conserves resources and enables a fast, scalable automation setup.

-   **Validated Fingerprints:**
    The nstbrowser project includes a database of valid fingerprints and knows how to obfuscate them. This ensures that automated processes appear as human-like as possible, minimizing the chance of being blocked (e.g., by Imperva).

### Why Is This Ideal for Automation?

-   **Resource Efficient:**
    Because browserless manages multiple sessions within a single container, resources are used efficiently, and separate browser instances do not need to be launched for every request.

-   **Fast Response Times:**
    Using the WebSocket API enables near-instant control of the browser, which, combined with optimized fingerprints, leads to fast and reliable automations.

-   **Flexibility and Scalability:**
    The modular architecture allows for the easy integration of additional workflows (e.g., dynamic fingerprinting and IP management). This makes the system well-suited for complex automation scenarios.

This architecture makes our solution particularly powerful – ideal for automated authentications, data extraction, and other tasks that require reliable browser interactions.

## Prerequisites

Ensure the following prerequisites are met on your system:

-   Node.js (recommended: the latest LTS version)
-   Docker

## Installation

Follow these steps in the given order to install and run the application:

1.  **Install pnpm**

    ```bash
    npm install -g pnpm@latest-10
    ```

2.  **Install Dependencies**

    ```bash
    pnpm install
    ```
  set proxys in proxys.json

3  **Build**
    ```bash
    sudo docker compose build 
    ```

4.  **Start the V-Login & Browserless Docker Container**

    This command runs the container in the host network and removes it automatically when it stops:

    ```bash
    sudo docker compose up -d 
    ```
