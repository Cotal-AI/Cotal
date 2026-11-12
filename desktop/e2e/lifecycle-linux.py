#!/usr/bin/env python3
"""Native Linux lifecycle probe. Run with /usr/bin/python3 on the app's display/bus.

Describe first, retain appStartTime/panelStartTime, then pass those tokens on every
mutation. The caller owns and starts both PIDs and must use an isolated desktop.
Examples:
  lifecycle-linux.py describe --pid PID --panel-pid PANEL --diagnostics DIR
  lifecycle-linux.py close-window --pid PID --start-time TOKEN --diagnostics DIR
  lifecycle-linux.py settings --pid PID --start-time TOKEN --panel-pid PANEL \
    --panel-start-time TOKEN --diagnostics DIR
close-window sends ONE WM_DELETE_WINDOW. Call twice on a fresh profile: the first
must leave the explanation visible, the second must hide. The caller asserts the
explanation and Settings content through its existing renderer driver.
Native tray activation uses the app-owned exported D-Bus menu, after retaining the
panel's actual right-click screenshot. No process termination or coordinate guesses.
"""

import argparse
import configparser
import shlex
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def command(*args):
    return subprocess.run(args, check=True, text=True, capture_output=True,
                          timeout=10).stdout


def identity(pid):
    root = Path('/proc') / str(pid)
    if root.stat().st_uid != os.getuid():
        raise RuntimeError(f'PID {pid} is not owned by this user')
    # comm may contain spaces and parentheses. Fields after the final ) start at 3.
    fields = (root / 'stat').read_text().rsplit(')', 1)[1].split()
    if fields[0] == 'Z':
        raise RuntimeError(f'PID {pid} is a zombie')
    return {'pid': pid, 'startTime': fields[19], 'exe': str((root / 'exe').resolve(strict=True))}


def verify(pid, token):
    current = identity(pid)
    if token is None or current['startTime'] != token:
        raise RuntimeError(f'PID {pid} start-time mismatch or missing ownership token')
    return current


def windows(pid):
    result = []
    for line in command('wmctrl', '-lpG').splitlines():
        parts = line.split(None, 8)
        if len(parts) < 8 or parts[2] != str(pid):
            continue
        xid = parts[0]
        info = command('xwininfo', '-id', xid)
        result.append({'id': xid, 'pid': pid, 'title': parts[8] if len(parts) > 8 else '',
                       'visible': 'Map State: IsViewable' in info,
                       'geometry': [int(x) for x in parts[3:7]]})
    return result


def nodes(root, depth=0):
    if depth > 32:
        return
    yield root, depth
    for child in root:
        yield from nodes(child, depth + 1)


def accessible_rows(app):
    rows = []
    for node, depth in nodes(app):
        try:
            state = node.getState()
            row = {'depth': depth, 'name': node.name, 'role': node.getRoleName(),
                   'description': node.description,
                   'visible': state.contains(pyatspi.STATE_VISIBLE),
                   'showing': state.contains(pyatspi.STATE_SHOWING)}
            row['attributes'] = list(node.getAttributes())
            try:
                rect = node.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
                row['bounds'] = [rect.x, rect.y, rect.width, rect.height]
            except Exception:
                pass
            try:
                row['text'] = node.queryText().getText(0, -1)
            except Exception:
                pass
            rows.append(row)
        except Exception as error:
            rows.append({'depth': depth, 'error': str(error)})
    return rows


def apps():
    for app in pyatspi.Registry.getDesktop(0):
        if app.get_process_id() in {args.pid, args.panel_pid}:
            yield app


def snapshot():
    result = {'app': identity(args.pid), 'windows': windows(args.pid), 'trees': []}
    if args.panel_pid:
        result['panel'] = identity(args.panel_pid)
    for app in apps():
        result['trees'].append({'pid': app.get_process_id(), 'rows': accessible_rows(app)})
    # Keep the tree artifact even when the app or panel is inaccessible.
    return result


def move_pointer(x, y, receipt, persist):
    deadline = time.monotonic() + 2

    def observe(field):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise subprocess.TimeoutExpired(['xdotool', 'getmouselocation', '--shell'], 2)
        result = subprocess.run(['xdotool', 'getmouselocation', '--shell'],
                                check=True, text=True, capture_output=True, timeout=remaining)
        observation = {'value': result.stdout}
        receipt[field] = observation
        persist()
        if time.monotonic() > deadline:
            raise subprocess.TimeoutExpired(['xdotool', 'getmouselocation', '--shell'], 2)
        fields = {}
        for line in result.stdout.splitlines():
            key, separator, value = line.partition('=')
            if not separator or key in fields:
                raise RuntimeError('Malformed native pointer location')
            fields[key] = value
        if any(not fields.get(key, '').isdigit() for key in ('X', 'Y')):
            raise RuntimeError('Malformed native pointer coordinates')
        return observation, (int(fields['X']), int(fields['Y']))

    try:
        before, position = observe('pointerBefore')
        receipt['pointerBefore'] = before
        persist()
        receipt['skipped'] = position == (x, y)
        if not receipt['skipped']:
            result = subprocess.run(['xdotool', 'mousemove', str(x), str(y)],
                                    text=True, capture_output=True,
                                    timeout=max(0.001, deadline - time.monotonic()))
            receipt.update(exit=result.returncode, stdout=result.stdout, stderr=result.stderr)
            result.check_returncode()
            while True:
                after, position = observe('pointerAfter')
                receipt['pointerAfter'] = after
                persist()
                if position == (x, y):
                    break
                time.sleep(min(0.05, max(0, deadline - time.monotonic())))
        else:
            receipt['pointerAfter'] = before
        receipt['state'] = 'completed'
    except subprocess.TimeoutExpired:
        receipt['state'] = 'timeout'
        raise
    except Exception as error:
        receipt.update(state='failed', error=str(error))
        raise
    finally:
        persist()


def click_unique(pid_set, names, roles=None, button=1):
    matches = []
    for app in apps():
        if app.get_process_id() not in pid_set:
            continue
        for node, _ in nodes(app):
            state = node.getState()
            if (node.name in names and (roles is None or node.getRoleName() in roles)
                    and state.contains(pyatspi.STATE_SHOWING)
                    and state.contains(pyatspi.STATE_VISIBLE)):
                rect = node.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
                if rect.width > 0 and rect.height > 0 and rect.x >= 0 and rect.y >= 0:
                    matches.append((node, rect))
    if len(matches) != 1:
        raise RuntimeError(f'Expected one visible native control {names}, found {len(matches)}')
    verify(args.pid, args.start_time)
    verify(args.panel_pid, args.panel_start_time)
    node, rect = matches[0]
    target = {'x': rect.x + rect.width // 2, 'y': rect.y + rect.height // 2,
              'bounds': [rect.x, rect.y, rect.width, rect.height]}
    report['indicatorInput'] = {'target': target, 'phases': []}
    for phase, argv in [('move', ['xdotool', 'mousemove', str(target['x']), str(target['y'])]),
                        ('click', ['xdotool', 'click', str(button)])]:
        verify(args.pid, args.start_time)
        verify(args.panel_pid, args.panel_start_time)
        receipt = {'phase': phase, 'argv': argv, 'state': 'started',
                   'atUnixMs': time.time_ns() // 1000000}
        report['indicatorInput']['phases'].append(receipt)
        save('indicator-input', report['indicatorInput'])
        if phase == 'move':
            started = time.monotonic()
            def persist_move():
                receipt['elapsedMs'] = (time.monotonic() - started) * 1000
                save('indicator-input', report['indicatorInput'])
            move_pointer(target['x'], target['y'], receipt, persist_move)
            continue
        def pointer_observation():
            try:
                return {'value': command('xdotool', 'getmouselocation', '--shell')}
            except Exception as pointer_error:
                return {'error': str(pointer_error)}
        receipt['pointerBefore'] = pointer_observation()
        save('indicator-input', report['indicatorInput'])
        started = time.monotonic()
        try:
            result = subprocess.run(argv, text=True, capture_output=True, timeout=10)
            receipt.update(state='completed', elapsedMs=(time.monotonic() - started) * 1000,
                           exit=result.returncode, stdout=result.stdout, stderr=result.stderr)
            receipt['pointerAfter'] = pointer_observation()
            save('indicator-input', report['indicatorInput'])
            result.check_returncode()
        except subprocess.TimeoutExpired as error:
            receipt.update(state='timeout', elapsedMs=(time.monotonic() - started) * 1000,
                           stdout=str(error.stdout or ''), stderr=str(error.stderr or ''))
            receipt['pointerAfter'] = pointer_observation()
            save('indicator-input', report['indicatorInput'])
            raise
    return {'name': node.name, 'role': node.getRoleName(), 'button': button, 'target': target}


def owned_indicator():
    from gi.repository import Gio, GLib
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    reply = bus.call_sync('org.kde.StatusNotifierWatcher', '/StatusNotifierWatcher',
                          'org.freedesktop.DBus.Properties', 'Get',
                          GLib.Variant('(ss)', ('org.kde.StatusNotifierWatcher', 'RegisteredStatusNotifierItems')),
                          None, Gio.DBusCallFlags.NONE, 5000, None).unpack()
    items = reply[0]
    if hasattr(items, 'unpack'):
        items = items.unpack()
    if len(items) != 1:
        raise RuntimeError(f'Owned private tray must have one registered indicator, found {len(items)}')
    service = items[0].split('/', 1)[0]
    owner = bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
                         'org.freedesktop.DBus', 'GetConnectionUnixProcessID',
                         GLib.Variant('(s)', (service,)), None,
                         Gio.DBusCallFlags.NONE, 5000, None).unpack()[0]
    if owner != args.pid:
        raise RuntimeError('Private tray indicator is not owned by the exact app PID')
    item_path = '/' + items[0].split('/', 1)[1]
    menu_path = bus.call_sync(service, item_path, 'org.freedesktop.DBus.Properties', 'Get',
                              GLib.Variant('(ss)', ('org.kde.StatusNotifierItem', 'Menu')),
                              None, Gio.DBusCallFlags.NONE, 5000, None).unpack()[0]
    if hasattr(menu_path, 'unpack'):
        menu_path = menu_path.unpack()
    layout = bus.call_sync(service, menu_path, 'com.canonical.dbusmenu', 'GetLayout',
                           GLib.Variant('(iias)', (0, -1, ['label', 'enabled', 'visible'])),
                           None, Gio.DBusCallFlags.NONE, 5000, None).unpack()
    def plain(value):
        if hasattr(value, 'unpack'):
            return plain(value.unpack())
        if isinstance(value, dict):
            return {key: plain(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [plain(item) for item in value]
        return value
    verify(args.pid, args.start_time)
    return {'registration': items[0], 'pid': owner, 'menuPath': menu_path,
            'exportedLayout': plain(layout)}


def click_native_menu(label):
    from gi.repository import Gio, GLib
    if label not in {'Settings…', 'Quit app (computer stays connected)'}:
        raise RuntimeError('Unsupported native tray action')
    indicator = owned_indicator()
    matches = []
    def visit(node):
        item_id, properties, children = node
        if (properties.get('label') == label and properties.get('enabled', True)
                and properties.get('visible', True)):
            matches.append(item_id)
        for child in children:
            visit(child)
    visit(indicator['exportedLayout'][1])
    if len(matches) != 1:
        raise RuntimeError(f'Expected one enabled visible exported menu item {label}, found {len(matches)}')
    # StatusNotifier menus are drawn by the panel plugin. Ownership belongs to the
    # exported menu's unique bus connection, not the plugin's popup window PID.
    service = indicator['registration'].split('/', 1)[0]
    if not service.startswith(':'):
        raise RuntimeError('Native menu activation requires a unique bus connection name')
    verify(args.pid, args.start_time)
    if owned_indicator() != indicator:
        raise RuntimeError('Owned native menu changed before activation')
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    owner = bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
                         'org.freedesktop.DBus', 'GetConnectionUnixProcessID',
                         GLib.Variant('(s)', (service,)), None,
                         Gio.DBusCallFlags.NONE, 5000, None).unpack()[0]
    if owner != args.pid:
        raise RuntimeError('Native menu bus connection changed owner before activation')
    verify(args.pid, args.start_time)
    # dbusmenu timestamps are X11 server milliseconds, with zero meaning unknown.
    timestamp = 0
    event = {'name': label, 'method': 'com.canonical.dbusmenu.Event', 'service': service,
             'menuPath': indicator['menuPath'], 'pid': owner, 'id': matches[0],
             'event': 'clicked', 'data': 0, 'timestamp': timestamp}
    report['menuActivation'] = save('menu-activation', event)
    bus.call_sync(service, indicator['menuPath'], 'com.canonical.dbusmenu', 'Event',
                  GLib.Variant('(isvu)', (matches[0], 'clicked', GLib.Variant('i', 0), timestamp)),
                  None, Gio.DBusCallFlags.NONE, 5000, None)
    return event


def dom_node(element_id):
    matches = []
    for app in apps():
        if app.get_process_id() != args.pid:
            continue
        for node, _ in nodes(app):
            attributes = dict(value.split(':', 1) for value in node.getAttributes() if ':' in value)
            if attributes.get('id') == element_id or attributes.get('html-id') == element_id:
                state = node.getState()
                if state.contains(pyatspi.STATE_VISIBLE) and state.contains(pyatspi.STATE_SHOWING):
                    matches.append(node)
    if len(matches) != 1:
        raise RuntimeError(f'Expected one visible owned DOM id {element_id}, found {len(matches)}')
    return matches[0]


def dom_text(element_id):
    node = dom_node(element_id)
    value = node.queryText().getText(0, -1)
    if not value.strip():
        raise RuntimeError(f'Owned DOM id {element_id} exposes no text')
    return value


def tray_status():
    # WebKit omits the header pill from AT-SPI. Read the native tray's status
    # instead, not an inferred header label or a global text match.
    verify(args.pid, args.start_time)
    indicator = owned_indicator()
    # The pinned product menu puts status first, ahead of the disabled updater.
    items = indicator['exportedLayout'][1][2]
    if not items:
        raise RuntimeError('Expected first direct native tray status leaf')
    _, properties, children = items[0]
    label = properties.get('label')
    if (children or properties.get('enabled') is not False
            or properties.get('visible') is not True
            or not isinstance(label, str) or not label.strip()):
        raise RuntimeError('Expected first direct native tray status leaf')
    verify(args.pid, args.start_time)
    report['indicator'] = indicator
    report['labelSource'] = 'owned-native-tray-menu'
    return label


def settings_back_action_diagnostics(button, action):
    """Observe the refused interface only, without changing press admission."""
    receipt = {'pid': args.pid, 'startTime': args.start_time,
               'beforeTree': report.get('before'), 'controlId': 'open-settings',
               'actions': [], 'errors': []}
    report['settingsBackAction'] = receipt

    def observe(field, read):
        try:
            receipt[field] = read()
        except Exception as error:
            receipt['errors'].append({'field': field, 'error': str(error)})

    observe('appPid', lambda: button.getApplication().get_process_id())
    observe('name', lambda: button.name)
    observe('role', lambda: button.getRoleName())
    observe('attributes', lambda: button.getAttributes())
    observe('nActions', lambda: action.nActions)
    try:
        for index in range(receipt.get('nActions', 0)):
            entry = {'index': index}
            receipt['actions'].append(entry)
            try:
                entry['name'] = action.getName(index)
            except Exception as error:
                entry['error'] = str(error)
    except Exception as error:
        receipt['errors'].append({'field': 'actions', 'error': str(error)})


def settings_back():
    verify(args.pid, args.start_time)
    if dom_text('settings-title') != 'Settings':
        raise RuntimeError('Owned Settings title must be Settings')
    button = dom_node('open-settings')
    if (button.getRoleName() != 'push button'
            or button.name != 'Back'
            or not button.getState().contains(pyatspi.STATE_ENABLED)):
        raise RuntimeError('Owned Settings Back must be an enabled Back button')
    action = button.queryAction()
    presses = [index for index in range(action.nActions)
               if action.getName(index) == 'press']
    if len(presses) != 1:
        settings_back_action_diagnostics(button, action)
        raise RuntimeError('Owned Settings Back must expose one native press action')
    verify(args.pid, args.start_time)
    if not action.doAction(presses[0]):
        raise RuntimeError('Owned Settings Back native press failed')
    def returned():
        verify(args.pid, args.start_time)
        try:
            dom_node('settings-title')
        except RuntimeError as error:
            if str(error) != 'Expected one visible owned DOM id settings-title, found 0':
                raise
        else:
            return False
        dom_text('connection-title')
        return True
    wait_for('owned Settings Back to return to connected view', returned)
    verify(args.pid, args.start_time)
    report.update(title='Settings', label='Back')


def wait_for(label, test):
    deadline = time.monotonic() + args.timeout
    while time.monotonic() < deadline:
        if test():
            return
        time.sleep(0.15)
    raise RuntimeError(f'Timed out waiting for {label}')


parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument('binary_or_action')
parser.add_argument('wrapper_action', nargs='?', choices=['describe', 'close-window', 'settings', 'quit', 'login-entry', 'connected-view', 'disable-login', 'settings-back'])
parser.add_argument('--pid', type=int)
parser.add_argument('--start-time')
parser.add_argument('--panel-pid', type=int, default=int(os.environ['COTAL_E2E_PANEL_PID']) if os.environ.get('COTAL_E2E_PANEL_PID') else None)
parser.add_argument('--panel-start-time')
parser.add_argument('--diagnostics', type=Path, default=Path(os.environ.get('RUNNER_TEMP', os.environ.get('XDG_STATE_HOME', '/tmp'))) / 'desktop-e2e-lifecycle')
parser.add_argument('--timeout', type=float, default=10)
args = parser.parse_args()
args.action = args.wrapper_action or args.binary_or_action
if args.wrapper_action:
    binary = Path(args.binary_or_action).resolve(strict=True)
    def find_owned(executable):
        found = []
        for proc in Path('/proc').iterdir():
            if not proc.name.isdecimal():
                continue
            try:
                current = identity(int(proc.name))
                if current['exe'] == str(executable):
                    found.append(current)
            except (OSError, RuntimeError):
                continue
        if len(found) != 1:
            raise RuntimeError(f'Expected one owned {executable}, found {len(found)}')
        return found[0]
    owned = find_owned(binary)
    args.pid, args.start_time = owned['pid'], owned['startTime']
    if args.panel_pid is not None:
        args.panel_start_time = identity(args.panel_pid)['startTime']
    if args.action in {'describe', 'settings', 'quit'} and args.panel_pid is None:
        import shutil
        panel_exe = shutil.which('xfce4-panel')
        if panel_exe is None:
            raise RuntimeError('xfce4-panel is required on the disposable desktop')
        panel = find_owned(Path(panel_exe).resolve(strict=True))
        args.panel_pid, args.panel_start_time = panel['pid'], panel['startTime']
if args.action not in {'describe', 'close-window', 'settings', 'quit', 'login-entry', 'connected-view', 'disable-login', 'settings-back'}:
    parser.error('Unknown action')
if args.pid is None:
    parser.error('--pid is required without the binary/action interface')
if args.pid <= 1 or (args.panel_pid is not None and (args.panel_pid <= 1 or args.panel_pid == args.pid)):
    parser.error('App and panel must be distinct owned PIDs greater than 1')
args.diagnostics.mkdir(parents=True, exist_ok=True)
stamp = f'{time.time_ns()}-{args.action}'
report = {'action': args.action, 'pid': args.pid, 'panelPid': args.panel_pid}


def save(suffix, value):
    path = args.diagnostics / f'{stamp}-{suffix}.json'
    path.write_text(json.dumps(value, indent=2) + '\n')
    return str(path)


try:
    if args.action == 'login-entry':
        if not args.wrapper_action:
            raise RuntimeError('login-entry requires binary/action interface')
        # auto-launch 0.6 uses HOME/.config, not XDG_CONFIG_HOME.
        entry = Path(os.environ['HOME']) / '.config/autostart/Cotal.desktop'
        config = configparser.ConfigParser(interpolation=None)
        config.read_string(entry.read_text())
        section = config['Desktop Entry']
        argv = shlex.split(section['Exec'])
        if (section.get('Type') != 'Application' or section.get('Hidden', 'false').lower() == 'true'
                or len(argv) != 2 or Path(argv[0]).resolve(strict=True) != binary or argv[1:] != ['--background']):
            raise RuntimeError(f'Unexpected Cotal login entry: {entry}')
        print(json.dumps({'pid': args.pid, 'visible': False, 'path': str(binary), 'args': argv[1:], 'entry': str(entry)}))
        sys.exit(0)
    import pyatspi
    report['before'] = save('before', snapshot())
    if args.action != 'describe':
        verify(args.pid, args.start_time)
    if args.action == 'connected-view':
        report['title'] = dom_text('connection-title')
        report['label'] = tray_status()
    elif args.action == 'settings-back':
        settings_back()
    elif args.action == 'disable-login':
        checkbox = dom_node('autostart')
        if checkbox.getRoleName() != 'check box':
            raise RuntimeError('Owned DOM id autostart is not a checkbox')
        state = checkbox.getState()
        if not state.contains(pyatspi.STATE_ENABLED):
            raise RuntimeError('Owned autostart checkbox is disabled')
        if state.contains(pyatspi.STATE_CHECKED):
            rect = checkbox.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
            if rect.width <= 0 or rect.height <= 0 or rect.x < 0 or rect.y < 0:
                raise RuntimeError('Owned autostart checkbox has no clickable bounds')
            verify(args.pid, args.start_time)
            report['autostartInput'] = {'phase': 'move', 'state': 'started'}
            move_pointer(rect.x + rect.width // 2, rect.y + rect.height // 2,
                         report['autostartInput'],
                         lambda: save('autostart-input', report['autostartInput']))
            verify(args.pid, args.start_time)
            command('xdotool', 'click', '1')
            wait_for('owned autostart unchecked', lambda: not dom_node('autostart').getState().contains(pyatspi.STATE_CHECKED))
        report['checked'] = False
    elif args.action == 'close-window':
        visible = [w for w in windows(args.pid) if w['visible']]
        if len(visible) != 1:
            raise RuntimeError(f'Expected one visible owned window, found {len(visible)}')
        verify(args.pid, args.start_time)
        command('wmctrl', '-ic', visible[0]['id'])
        time.sleep(0.5)
        report['firstClose'] = save('first-close', snapshot())
        if args.wrapper_action and any(w['visible'] for w in windows(args.pid)):
            # Preserve the first explanation tree before the second WM close.
            verify(args.pid, args.start_time)
            command('wmctrl', '-ic', visible[0]['id'])
        if args.wrapper_action:
            wait_for('owned window hidden after WM close', lambda: not any(w['visible'] for w in windows(args.pid)))
    elif args.action in {'settings', 'quit'}:
        if args.panel_pid is None:
            raise RuntimeError('Native tray actions require the owned --panel-pid')
        panel = verify(args.panel_pid, args.panel_start_time)
        if Path(panel['exe']).name != 'xfce4-panel':
            raise RuntimeError('Expected the owned xfce4-panel native AppIndicator host')
        report['indicator'] = owned_indicator()
        # This systray-only panel exposes the registered item as an unnamed button.
        # Both the unique registration's PID and the panel's start token are required.
        report['indicatorClick'] = click_unique({args.panel_pid}, {''}, {'push button'}, button=3)
        time.sleep(0.4)
        report['menu'] = save('menu', snapshot())
        display = args.diagnostics / f'{stamp}-menu-display.png'
        capture = subprocess.run(['import', '-window', 'root', str(display)],
                                 text=True, capture_output=True, timeout=10)
        report['menuDisplay'] = {'path': str(display), 'exit': capture.returncode,
                                 'error': capture.stderr.strip()}
        report['observedMenuItems'] = [row for tree in snapshot()['trees']
                                       for row in tree['rows']
                                       if row.get('role') in {'menu item', 'check menu item'}]
        label = 'Settings…' if args.action == 'settings' else 'Quit app (computer stays connected)'
        report['menuClick'] = click_native_menu(label)
        if args.action == 'settings':
            def restored_and_focused():
                active = command('xprop', '-root', '_NET_ACTIVE_WINDOW').strip()
                try:
                    xid = int(active.rsplit(' ', 1)[-1], 16)
                except ValueError:
                    return False
                return any(w['visible'] and int(w['id'], 16) == xid for w in windows(args.pid))
            wait_for('owned window restored and focused by Settings', restored_and_focused)
            report['activeWindow'] = command('xprop', '-root', '_NET_ACTIVE_WINDOW').strip()
        else:
            def exited():
                try:
                    return identity(args.pid)['startTime'] != args.start_time
                except (FileNotFoundError, ProcessLookupError):
                    return True
                except RuntimeError as error:
                    if 'zombie' in str(error):
                        return True
                    raise
            wait_for('owned app exit after native Quit app (computer stays connected)', exited)
            report['exited'] = True
    if not report.get('exited'):
        after = snapshot()
        report['after'] = save('after', after)
        report['appStartTime'] = after['app']['startTime']
        report['panelStartTime'] = after.get('panel', {}).get('startTime')
        report['windows'] = after['windows']
        report['visible'] = any(w['visible'] for w in after['windows'])
    else:
        report['visible'] = False
    print(json.dumps(report))
except Exception as error:
    report['error'] = f'{type(error).__name__}: {error}'
    try:
        display = args.diagnostics / f'{stamp}-failure-display.png'
        capture = subprocess.run(['import', '-window', 'root', str(display)],
                                 text=True, capture_output=True, timeout=10)
        report['failureDisplay'] = {'path': str(display), 'exit': capture.returncode,
                                    'error': capture.stderr.strip()}
    except Exception as diagnostic_error:
        report['failureDisplayError'] = str(diagnostic_error)
    try:
        report['failureTree'] = save('failure-tree', snapshot())
    except Exception as diagnostic_error:
        report['diagnosticError'] = str(diagnostic_error)
    report['diagnostic'] = save('failure', report)
    print(json.dumps(report), file=sys.stderr)
    sys.exit(1)
