# Install TS6 Manager as an app

TS6 Manager can be installed from a supported browser and launched from your Home Screen, app launcher, or desktop. Installation is optional; the same interface works in a normal browser tab.

Use your deployment's **HTTPS** address. A trusted certificate is required; ordinary HTTP addresses on your LAN do not support installation or service workers. `localhost` is an exception for development. Serve the application at the domain root, as with the standard nginx deployments.

## iPhone and iPad

Open TS6 Manager in Safari, tap **Share → Add to Home Screen**, and confirm. Depending on your iOS version, enable **Open as Web App** if offered. Launch it using the new icon. You may need to sign in again: browser and Home Screen sessions can use separate storage.

## Android and desktop

Open TS6 Manager in Chrome, Edge, or another browser supporting web-app installation. Use the address-bar install icon or the browser menu's **Install app / Add to Home screen** option. Labels and availability vary by browser. Browsers without installation support can still use the website normally.

## Using the installed app

The installed app opens without the usual browser address bar. Navigation, Settings, login, and server management work as before. Use the navigation menu on smaller screens; GitHub and documentation links open separately. The app respects device safe areas and supports portrait and landscape orientation. Pinch zoom remains available.

## Updates

When an update is ready, an **Update available** notice appears. Finish your task and save changes in **all open TS6 Manager tabs/windows**, then choose **Reload all tabs**. Applying an update reloads those windows so the frontend code stays consistent. Updates are checked on launch, when returning to the app, and once a minute while visible. An update can also take effect after all app windows are closed.

An update never reloads a running session just because a new release was deployed. Unsaved form/editor changes are not preserved across an intentional reload. If an update fails, reconnect and retry.

## Connectivity and offline limits

After a successful first visit, the basic application interface can open without connectivity. **Live TeamSpeak administration always requires a connection to the backend and TeamSpeak server.** A server-unavailable notice warns when the browser is offline or the backend cannot be reached. Data still visible from the current session may be outdated; it is not an offline copy of your server.

API responses, authentication traffic, live server data, and administrative actions are not saved by the service worker. Actions are not queued for later replay. Sign-in and setup require connectivity. Remote fonts and media may be unavailable offline; system fonts remain usable. Previously cached static files can be removed by the browser under storage pressure, so offline opening is best-effort.

Uninstalling the app does not necessarily clear its browser storage or sign you out. Use **Log out** before removing it on a shared device; use the browser's site-data controls when you need to clear stored data.
