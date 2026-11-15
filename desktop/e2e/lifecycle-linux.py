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
Native tray activation right-clicks the single child of the panel's depth-3 plugin
container, watches dbus-monitor on the session bus to prove the opened menu is the
app's own, and selects the item with keyboard Down/Return. No process termination or
coordinate guesses.
"""

import argparse
import configparser
import re
import shlex
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
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


def process_info(pid):
    root = Path('/proc') / str(pid)
    if root.stat().st_uid != os.getuid():
        raise RuntimeError(f'PID {pid} is not owned by this user')
    fields = (root / 'stat').read_text().rsplit(')', 1)[1].split()
    return {'pid': pid, 'parentPid': int(fields[1]), 'state': fields[0],
            'startTime': fields[19], 'exe': str((root / 'exe').resolve(strict=True))}


def panel_children(panel_pid):
    children = []
    if panel_pid is None:
        return children
    for proc in sorted(Path('/proc').iterdir(), key=lambda p: int(p.name) if p.name.isdecimal() else 0):
        if not proc.name.isdecimal():
            continue
        try:
            info = process_info(int(proc.name))
            if info['parentPid'] == panel_pid:
                children.append(info)
        except Exception:
            continue
    return children


def desktop_snapshot():
    desktop_apps = []
    for app in pyatspi.Registry.getDesktop(0):
        row = {'name': getattr(app, 'name', '')}
        try:
            app_pid = app.get_process_id()
            row['pid'] = app_pid
            try:
                row.update(process_info(app_pid))
            except Exception as proc_error:
                row['processError'] = str(proc_error)
        except Exception as pid_error:
            row['pidError'] = str(pid_error)
        try:
            row['rows'] = accessible_rows(app)
        except Exception as rows_error:
            row['rowsError'] = str(rows_error)
            row['rows'] = []
        desktop_apps.append(row)
    return desktop_apps


def missing_control_diagnostics():
    """Retain read-only panel facts without admitting another control or input."""
    evidence = {'panelPid': args.panel_pid, 'tree': None, 'desktop': None,
                'desktopApps': [], 'panelChildren': [], 'plugins': [], 'errors': []}
    report['missingControl'] = evidence
    try:
        verify(args.panel_pid, args.panel_start_time)
        evidence['tree'] = save('missing-control-tree', snapshot())
    except Exception as error:
        evidence['errors'].append({'field': 'tree', 'error': str(error)})
    try:
        verify(args.panel_pid, args.panel_start_time)
        evidence['panelChildren'] = panel_children(args.panel_pid)
    except Exception as error:
        evidence['errors'].append({'field': 'panelChildren', 'error': str(error)})
    try:
        verify(args.panel_pid, args.panel_start_time)
        desktop_apps = desktop_snapshot()
        evidence['desktop'] = save('missing-control-desktop', desktop_apps)
        evidence['desktopApps'] = [
            {k: v for k, v in app.items() if k != 'rows'} | {'rowCount': len(app.get('rows', []))}
            for app in desktop_apps
        ]
    except Exception as error:
        evidence['errors'].append({'field': 'desktop', 'error': str(error)})
    argv = ['xfconf-query', '--channel', 'xfce4-panel', '--list', '--verbose']
    try:
        verify(args.panel_pid, args.panel_start_time)
        result = subprocess.run(argv, text=True, capture_output=True, timeout=10)
        evidence['plugins'].append({'argv': argv, 'exit': result.returncode,
                                    'stdout': result.stdout, 'stderr': result.stderr})
    except Exception as error:
        evidence['errors'].append({'field': 'plugins', 'error': str(error)})
    try:
        save('missing-control', evidence)
    except Exception as error:
        evidence['errors'].append({'field': 'write', 'error': str(error)})


def click_panel_tray_item(button=3):
    panel_apps = [app for app in apps() if app.get_process_id() == args.panel_pid]
    if len(panel_apps) != 1:
        missing_control_diagnostics()
        raise RuntimeError(f'Expected one owned panel AT-SPI application, found {len(panel_apps)}')
    containers = [node for node, depth in nodes(panel_apps[0]) if depth == 3]
    if len(containers) != 1:
        missing_control_diagnostics()
        raise RuntimeError(f'Expected one panel plugin container at depth 3, found {len(containers)}')
    children = list(containers[0])
    if len(children) != 1:
        missing_control_diagnostics()
        raise RuntimeError(f'Expected one child under the panel plugin container, found {len(children)}')
    node = children[0]
    rect = node.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
    if rect.width <= 0 or rect.height <= 0 or rect.x < 0 or rect.y < 0:
        missing_control_diagnostics()
        raise RuntimeError('Panel tray item child has no clickable bounds')
    verify(args.pid, args.start_time)
    verify(args.panel_pid, args.panel_start_time)
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
    return {'name': node.name, 'role': node.getRoleName(), 'button': button,
            'bounds': target['bounds'], 'clickPoint': {'x': target['x'], 'y': target['y']},
            'target': target}


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


def exported_menu_labels(exported_layout):
    labels = []
    def visit(node):
        _, properties, children = node
        if properties.get('visible', True) and properties.get('type') != 'separator':
            label = properties.get('label')
            if isinstance(label, str) and label and label != 'Label Empty':
                labels.append(label)
        for child in children:
            visit(child)
    visit(exported_layout[1])
    return labels


def navigable_menu_items(exported_layout):
    items = []
    def visit(node):
        item_id, properties, children = node
        if (properties.get('visible', True) and properties.get('enabled', True)
                and properties.get('type') != 'separator'):
            label = properties.get('label')
            if isinstance(label, str) and label and label != 'Label Empty':
                items.append({'id': item_id, 'label': label})
        for child in children:
            visit(child)
    visit(exported_layout[1])
    return items


def bus_connection_pid(service_name):
    from gi.repository import Gio, GLib
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    return int(bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
                             'org.freedesktop.DBus', 'GetConnectionUnixProcessID',
                             GLib.Variant('(s)', (service_name,)), None,
                             Gio.DBusCallFlags.NONE, 5000, None).unpack()[0])


def verify_panel_sender(sender_name, cache):
    if not sender_name or not sender_name.startswith(':'):
        raise RuntimeError(f'D-Bus menu call sender {sender_name!r} is not a unique bus connection')
    if sender_name not in cache:
        verify(args.panel_pid, args.panel_start_time)
        sender_pid = bus_connection_pid(sender_name)
        info = process_info(sender_pid)
        exe_name = Path(info['exe']).name
        if sender_pid == args.panel_pid and exe_name == 'xfce4-panel':
            role = 'panel'
        elif info['parentPid'] == args.panel_pid and exe_name == 'wrapper-2.0':
            role = 'panel-wrapper'
        else:
            raise RuntimeError(
                f'D-Bus menu call sender {sender_name} (PID {sender_pid}, parent {info["parentPid"]}, exe {info["exe"]}) '
                f'is neither owned xfce4-panel ({args.panel_pid}) nor its wrapper-2.0 child')
        cache[sender_name] = {'sender': sender_name, 'senderPid': sender_pid,
                              'senderParentPid': info['parentPid'], 'senderExe': info['exe'],
                              'senderRole': role}
    return cache[sender_name]


def parse_dbus_monitor_messages(lines, service, menu_path):
    blocks = []
    current = []
    for line in lines:
        if line.startswith(('method call ', 'method return ', 'signal ', 'error ')):
            if current:
                blocks.append(current)
            current = [line]
        elif current:
            current.append(line)
    if current:
        blocks.append(current)
    open_calls = []
    get_layout_serials = set()
    layout_replies = []
    clicked_events = []
    for block in blocks:
        header = block[0]
        body = '\n'.join(block[1:])
        dest_match = re.search(r'destination=([^\s;]+)', header)
        sender_match = re.search(r'sender=([^\s;]+)', header)
        dest_name = dest_match.group(1) if dest_match else ''
        sender_name = sender_match.group(1) if sender_match else ''
        if (header.startswith('method call ') and dest_name == service
                and f'path={menu_path};' in header and 'interface=com.canonical.dbusmenu;' in header):
            member_match = re.search(r'member=(\w+)', header)
            serial_match = re.search(r'serial=(\d+)', header)
            member = member_match.group(1) if member_match else ''
            serial = serial_match.group(1) if serial_match else ''
            if member == 'AboutToShow':
                open_calls.append({'member': member, 'sender': sender_name,
                                   'destination': dest_name, 'serial': serial, 'header': header})
            elif member == 'AboutToShowGroup':
                ids = [int(m) for m in re.findall(r'^\s*int32\s+(-?\d+)', body, re.MULTILINE)]
                if 0 in ids:
                    open_calls.append({'member': member, 'ids': ids, 'sender': sender_name,
                                       'destination': dest_name, 'serial': serial, 'header': header})
            elif member == 'GetLayout':
                open_calls.append({'member': member, 'sender': sender_name,
                                   'destination': dest_name, 'serial': serial, 'header': header})
                if serial:
                    get_layout_serials.add(serial)
            elif member == 'Event':
                int_match = re.search(r'^\s*int32\s+(-?\d+)', body, re.MULTILINE)
                str_match = re.search(r'^\s*string\s+"([^"]*)"', body, re.MULTILINE)
                event_id = int(int_match.group(1)) if int_match else None
                event_kind = str_match.group(1) if str_match else None
                if event_kind == 'opened':
                    open_calls.append({'member': 'Event', 'event': 'opened', 'id': event_id,
                                       'sender': sender_name, 'destination': dest_name,
                                       'serial': serial, 'header': header})
                elif event_kind == 'clicked':
                    clicked_events.append({'member': 'Event', 'id': event_id, 'event': 'clicked',
                                           'sender': sender_name, 'destination': dest_name,
                                           'serial': serial, 'header': header})
            elif member == 'EventGroup':
                for int_val, str_val in re.findall(
                        r'struct\s*\{\s*int32\s+(-?\d+)\s+string\s+"([^"]*)"', body):
                    event_id = int(int_val)
                    if str_val == 'opened':
                        open_calls.append({'member': 'EventGroup', 'event': 'opened', 'id': event_id,
                                           'sender': sender_name, 'destination': dest_name,
                                           'serial': serial, 'header': header})
                    elif str_val == 'clicked':
                        clicked_events.append({'member': 'EventGroup', 'id': event_id,
                                               'event': 'clicked', 'sender': sender_name,
                                               'destination': dest_name, 'serial': serial,
                                               'header': header})
        elif header.startswith('method return ') and sender_name == service:
            reply_match = re.search(r'reply_serial=(\d+)', header)
            reply_serial = reply_match.group(1) if reply_match else ''
            if reply_serial in get_layout_serials:
                labels = [
                    label for label in re.findall(
                        r'string "label"\s+variant\s+string "((?:[^"\\]|\\.)*)"', body)
                    if label and label != 'Label Empty'
                ]
                layout_replies.append({'sender': sender_name, 'replySerial': reply_serial,
                                       'labels': labels})
    return {'service': service, 'menuPath': menu_path, 'openCalls': open_calls,
            'layoutReplies': layout_replies, 'clickedEvents': clicked_events}


def start_dbus_menu_watch(indicator):
    service = indicator['registration'].split('/', 1)[0]
    if not service.startswith(':'):
        raise RuntimeError('Native menu watch requires a unique bus connection name')
    menu_path = indicator['menuPath']
    argv = ['dbus-monitor', '--session', f"path='{menu_path}'",
            f"destination='{service}'", f"sender='{service}'"]
    proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, bufsize=1)
    lines = []
    stderr_lines = []
    lock = threading.Lock()
    ready = threading.Event()
    def read_stdout():
        for line in proc.stdout:
            with lock:
                lines.append(line.rstrip('\n'))
            if 'member=NameAcquired' in line:
                ready.set()
    def read_stderr():
        for line in proc.stderr:
            with lock:
                stderr_lines.append(line.rstrip('\n'))
            if 'became a monitor' in line:
                ready.set()
    t_out = threading.Thread(target=read_stdout, daemon=True)
    t_err = threading.Thread(target=read_stderr, daemon=True)
    t_out.start()
    t_err.start()
    def snapshot_watch():
        with lock:
            current_lines = list(lines)
            current_err = list(stderr_lines)
        parsed = parse_dbus_monitor_messages(current_lines, service, menu_path)
        parsed.update(argv=argv, service=service, menuPath=menu_path,
                      rawLines=current_lines, stderrLines=current_err)
        return parsed
    def stop_watch():
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=2)
        t_out.join(timeout=1)
        t_err.join(timeout=1)
        return snapshot_watch()
    is_ready = ready.wait(timeout=2.0)
    exit_code = proc.poll()
    if not is_ready or exit_code is not None:
        failed_watch = stop_watch()
        failed_watch.update(ready=is_ready, exitCode=exit_code)
        report['menuWatch'] = save('menu-watch', failed_watch)
        raise RuntimeError(
            f'dbus-monitor failed to become an active session monitor (ready={is_ready}, exit={exit_code}): '
            f'{failed_watch["stderrLines"]}')
    time.sleep(0.05)
    return snapshot_watch, stop_watch


def select_open_menu_item(label, indicator, snapshot_watch):
    if label not in {'Settings…', 'Quit app (computer stays connected)'}:
        raise RuntimeError('Unsupported native tray action')
    service = indicator['registration'].split('/', 1)[0]
    if not service.startswith(':'):
        raise RuntimeError('Native menu watch requires a unique bus connection name')
    expected_labels = exported_menu_labels(indicator['exportedLayout'])
    navigable = navigable_menu_items(indicator['exportedLayout'])
    matches = [(idx + 1, item['id']) for idx, item in enumerate(navigable) if item['label'] == label]
    if len(matches) != 1:
        raise RuntimeError(f'Expected one enabled visible exported menu item {label}, found {len(matches)}')
    down_steps, target_id = matches[0]
    sender_cache = {}
    def menu_opened():
        observed = snapshot_watch()
        if not observed['openCalls']:
            return False
        if any(call['member'] == 'GetLayout' for call in observed['openCalls']):
            return bool(observed['layoutReplies'])
        return True
    try:
        wait_for('panel D-Bus menu open call on dbus-monitor', menu_opened)
    except Exception:
        observed = snapshot_watch()
        observed.update(targetLabel=label, targetId=target_id, downSteps=down_steps,
                        expectedLabels=expected_labels)
        report['menuWatch'] = save('menu-watch', observed)
        raise
    verify(args.pid, args.start_time)
    verify(args.panel_pid, args.panel_start_time)
    observed = snapshot_watch()
    try:
        for call in observed['openCalls']:
            call.update(verify_panel_sender(call['sender'], sender_cache))
    except Exception:
        observed.update(targetLabel=label, targetId=target_id, downSteps=down_steps,
                        expectedLabels=expected_labels)
        report['menuWatch'] = save('menu-watch', observed)
        raise
    if observed['layoutReplies']:
        wire_labels = observed['layoutReplies'][-1]['labels']
        if wire_labels != expected_labels:
            observed.update(targetLabel=label, targetId=target_id, downSteps=down_steps,
                            expectedLabels=expected_labels, wireLabels=wire_labels,
                            layoutObservation='GetLayout reply')
            report['menuWatch'] = save('menu-watch', observed)
            raise RuntimeError(f'Opened menu wire labels {wire_labels} do not match exportedLayout {expected_labels}')
        layout_observation = 'GetLayout reply matched exportedLayout'
    else:
        wire_labels = None
        layout_observation = 'no layout fetch observed'
    key_inputs = []
    for step in range(down_steps):
        verify(args.pid, args.start_time)
        verify(args.panel_pid, args.panel_start_time)
        command('xdotool', 'key', 'Down')
        key_inputs.append({'step': step + 1, 'key': 'Down'})
        time.sleep(0.05)
    verify(args.pid, args.start_time)
    verify(args.panel_pid, args.panel_start_time)
    command('xdotool', 'key', 'Return')
    key_inputs.append({'step': down_steps + 1, 'key': 'Return'})
    def item_clicked():
        return any(event['id'] == target_id and event['destination'] == service
                   for event in snapshot_watch()['clickedEvents'])
    try:
        wait_for(f'panel D-Bus Event({target_id}, clicked) for {label}', item_clicked)
    except Exception:
        observed = snapshot_watch()
        observed.update(targetLabel=label, targetId=target_id, downSteps=down_steps,
                        expectedLabels=expected_labels, wireLabels=wire_labels,
                        layoutObservation=layout_observation, keyInputs=key_inputs)
        report['menuWatch'] = save('menu-watch', observed)
        raise
    observed = snapshot_watch()
    try:
        for call in observed['openCalls']:
            call.update(verify_panel_sender(call['sender'], sender_cache))
        for event in observed['clickedEvents']:
            event.update(verify_panel_sender(event['sender'], sender_cache))
    except Exception:
        observed.update(targetLabel=label, targetId=target_id, downSteps=down_steps,
                        expectedLabels=expected_labels, wireLabels=wire_labels,
                        layoutObservation=layout_observation, keyInputs=key_inputs)
        report['menuWatch'] = save('menu-watch', observed)
        raise
    observed.update(targetLabel=label, targetId=target_id, downSteps=down_steps,
                    expectedLabels=expected_labels, wireLabels=wire_labels,
                    layoutObservation=layout_observation, keyInputs=key_inputs)
    report['menuWatch'] = save('menu-watch', observed)
    return {'name': label, 'id': target_id, 'service': service, 'downSteps': down_steps,
            'expectedLabels': expected_labels, 'wireLabels': wire_labels,
            'layoutObservation': layout_observation,
            'openCalls': observed['openCalls'], 'clickedEvents': observed['clickedEvents']}


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
        snapshot_watch, stop_watch = start_dbus_menu_watch(report['indicator'])
        right_clicked = False
        menu_selected = False
        try:
            # Locate the tray item as the single child of the panel's depth-3 plugin
            # container by its bounds in this run, then watch dbus-monitor and navigate
            # the opened menu with keyboard Down/Return.
            report['indicatorClick'] = click_panel_tray_item(button=3)
            right_clicked = True
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
            report['menuClick'] = select_open_menu_item(label, report['indicator'], snapshot_watch)
            menu_selected = True
        except Exception:
            if right_clicked and not menu_selected:
                try:
                    command('xdotool', 'key', 'Escape')
                except Exception:
                    pass
            raise
        finally:
            final_watch = stop_watch()
            if 'menuWatch' not in report:
                report['menuWatch'] = save('menu-watch', final_watch)
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
