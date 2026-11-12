"""Harness-only checks, with no native-success claim or GI dependency."""
import ast
from copy import deepcopy
from pathlib import Path
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import Mock


class ConnectedViewTests(unittest.TestCase):
    # Run29 native-lifecycle.jsonl line 21, login-launched PID 27243.
    indicator = {
        'registration': ':1.40/org/ayatana/NotificationItem/tray_icon_tray_app_machine',
        'pid': 27243,
        'menuPath': '/org/ayatana/NotificationItem/tray_icon_tray_app_machine/Menu',
        'exportedLayout': [2, [0, {'label': 'Label Empty', 'enabled': True, 'visible': True}, [
            [2, {'label': 'Connected', 'enabled': False, 'visible': True}, []],
            [6, {'label': 'No desktop update', 'enabled': False, 'visible': True}, []],
            [3, {'label': 'Settings…', 'enabled': True, 'visible': True}, []],
            [4, {'label': 'Open dashboard', 'enabled': True, 'visible': True}, []],
            [5, {'label': 'Quit app (computer stays connected)', 'enabled': True, 'visible': True}, []],
        ]]],
    }
    # Projection of app rows 7-11 and 14 from the first connected-view failure
    # tree. The visible header has no status-pill node, ID, name or Text.
    rows = [
        {'attributes': ['toolkit:WebKitGTK', 'xml-roles:complementary',
                        'computed-role:complementary', 'tag:aside']},
        {'attributes': ['toolkit:WebKitGTK', 'computed-role:strong', 'tag:strong'],
         'text': 'cotal'},
        {'attributes': ['toolkit:WebKitGTK', 'id:machine-name',
                        'computed-role:paragraph', 'tag:p'],
         'text': 'runnervm7aw5e E2E renamed'},
        {'attributes': ['toolkit:WebKitGTK', 'id:edit-computer-name',
                        'computed-role:button', 'tag:button']},
        {'attributes': ['toolkit:WebKitGTK', 'id:machine-details',
                        'computed-role:paragraph', 'tag:p'],
         'text': 'Linux · 64-bit Intel / AMD · 16 GB'},
        {'attributes': ['toolkit:WebKitGTK', 'level:1', 'id:connection-title',
                        'computed-role:heading', 'tag:h1'],
         'text': 'This computer is connected'},
    ]

    def environment(self, rows=None, pid=27243):
        source = ast.parse(Path(__file__).with_name('lifecycle-linux.py').read_text())
        functions = ast.Module(body=[n for n in source.body if isinstance(n, ast.FunctionDef)],
                               type_ignores=[])
        env = {'args': SimpleNamespace(pid=27243, start_time='74143'), 'report': {},
               'pyatspi': SimpleNamespace(STATE_VISIBLE='visible', STATE_SHOWING='showing')}
        exec(compile(functions, '<real lifecycle functions>', 'exec'), env)
        native_nodes = []
        for row in self.rows if rows is None else rows:
            native_nodes.append(SimpleNamespace(
                getAttributes=lambda r=row: r['attributes'],
                getState=lambda r=row: SimpleNamespace(contains=lambda state: r.get(state, True)),
                queryText=lambda r=row: SimpleNamespace(getText=lambda *_: r.get('text', ''))))
        env.update(apps=lambda: [SimpleNamespace(get_process_id=lambda: pid)],
                   nodes=lambda _: [(node, 0) for node in native_nodes],
                   owned_indicator=Mock(return_value=deepcopy(self.indicator)), verify=Mock())
        dispatch = next(n for n in ast.walk(source) if isinstance(n, ast.If)
                        and ast.unparse(n.test) == "args.action == 'connected-view'")
        return env, compile(ast.Module(body=dispatch.body, type_ignores=[]),
                            '<real connected-view dispatch>', 'exec')

    def test_retained_login_tree_and_owned_native_menu(self):
        env, dispatch = self.environment()
        exec(dispatch, env)
        self.assertEqual(env['report']['title'], 'This computer is connected')
        self.assertEqual(env['report']['label'], 'Connected')
        self.assertEqual(env['report']['labelSource'], 'owned-native-tray-menu')
        self.assertEqual(env['report']['indicator'], self.indicator)
        env['owned_indicator'].assert_called_once_with()
        self.assertEqual(env['verify'].call_args_list,
                         [unittest.mock.call(27243, '74143')] * 2)

    def test_second_disabled_update_is_ignored(self):
        env, dispatch = self.environment()
        exec(dispatch, env)
        self.assertEqual(env['report']['label'], 'Connected')
        self.assertEqual(env['report']['indicator']['exportedLayout'][1][2][1][1]['label'],
                         'No desktop update')

    def test_status_is_raw_native_text_not_derived_from_title(self):
        env, dispatch = self.environment()
        env['owned_indicator'].return_value['exportedLayout'][1][2][0][1]['label'] = 'Ready'
        exec(dispatch, env)
        self.assertEqual(env['report']['label'], 'Ready')
        self.assertEqual(env['report']['title'], 'This computer is connected')

    def test_current_product_menu_pins_status_before_disabled_update(self):
        source = Path(__file__).parents[1].joinpath('src-tauri/src/app.rs').read_text()
        self.assertIn('Menu::with_items(app, &[&status, &update, &settings, &dashboard, &quit])?',
                      source)
        self.assertIn('"Quit app (computer stays connected)"', source)

    def test_status_requires_first_visible_disabled_nonblank_direct_leaf(self):
        invalid = [[]]
        for change in [{'visible': False}, {'enabled': True}, {'label': ''},
                       {'label': '  '}, {'label': None}, {'visible': 1}, {'enabled': 0}]:
            row = deepcopy(self.indicator['exportedLayout'][1][2][0])
            row[1].update(change)
            invalid.append([row])
        for missing in ['visible', 'enabled', 'label']:
            row = deepcopy(self.indicator['exportedLayout'][1][2][0])
            del row[1][missing]
            invalid.append([row])
        # A nested status and an enabled action named Connected cannot substitute.
        invalid.append([[8, {'label': 'Submenu', 'enabled': False, 'visible': True},
                         [deepcopy(self.indicator['exportedLayout'][1][2][0])]]])
        for children in invalid:
            with self.subTest(children=children):
                env, dispatch = self.environment()
                env['owned_indicator'].return_value['exportedLayout'][1][2] = children
                with self.assertRaisesRegex(RuntimeError, 'first direct native tray status leaf'):
                    exec(dispatch, env)
                self.assertNotIn('label', env['report'])
                # Neither a later valid Connected leaf nor the updater repairs the first item.
                if children:
                    children.extend(deepcopy(self.indicator['exportedLayout'][1][2][:2]))
                    with self.assertRaisesRegex(RuntimeError, 'first direct native tray status leaf'):
                        exec(dispatch, env)
                    self.assertNotIn('label', env['report'])

    def test_birth_and_owned_indicator_failures_propagate(self):
        for where in ['before', 'indicator', 'after']:
            with self.subTest(where=where):
                env, dispatch = self.environment()
                if where == 'indicator':
                    env['owned_indicator'].side_effect = RuntimeError('foreign tray PID')
                else:
                    env['verify'].side_effect = ([RuntimeError('birth mismatch')]
                                                if where == 'before' else
                                                [None, RuntimeError('birth mismatch')])
                with self.assertRaisesRegex(RuntimeError, 'birth mismatch|foreign tray PID'):
                    exec(dispatch, env)
                self.assertNotIn('label', env['report'])
                if where == 'before':
                    env['owned_indicator'].assert_not_called()

    def test_title_remains_unique_visible_and_owned(self):
        for rows, pid in [(self.rows, 999), (self.rows[:-1], 27243),
                          (self.rows + [self.rows[-1]], 27243),
                          (self.rows[:-1] + [dict(self.rows[-1], visible=False)], 27243),
                          (self.rows[:-1] + [dict(self.rows[-1], showing=False)], 27243)]:
            with self.subTest(rows=rows, pid=pid):
                env, dispatch = self.environment(rows, pid)
                with self.assertRaisesRegex(RuntimeError, 'visible owned DOM id connection-title'):
                    exec(dispatch, env)
                env['owned_indicator'].assert_not_called()


class SettingsBackTests(unittest.TestCase):
    def environment(self, title='Settings', label='Back', enabled=True, pid=27243,
                    missing=False, visible=True, showing=True, role='push button',
                    button_text=None):
        env, _ = ConnectedViewTests().environment()
        env['pyatspi'].STATE_ENABLED = 'enabled'
        action = SimpleNamespace(nActions=1, getName=lambda _: 'press')
        returned = False
        def click(_):
            nonlocal returned
            returned = True
            return True
        action.doAction = Mock(side_effect=click)
        def node(element_id, text):
            # Run32 PID 27233 before/failure-tree: open-settings has name Back,
            # push button role and no Text, while settings-title has Text Settings.
            query_text = Mock(return_value=SimpleNamespace(getText=lambda *_: text))
            if element_id == 'open-settings':
                if button_text is None:
                    query_text.side_effect = NotImplementedError('button Text unsupported')
                else:
                    query_text.return_value = SimpleNamespace(getText=lambda *_: button_text)
            return SimpleNamespace(
                name=text,
                getApplication=lambda: SimpleNamespace(get_process_id=lambda: pid),
                getAttributes=lambda: [f'id:{element_id}'],
                getState=lambda: SimpleNamespace(contains=lambda state:
                    enabled if state == 'enabled' else
                    showing if state == 'showing' else visible),
                queryText=query_text,
                getRoleName=lambda: role if element_id == 'open-settings' else 'heading',
                queryAction=lambda: action)
        def nodes(_):
            if returned:
                return [(node('connection-title', 'This computer is connected'), 0)]
            rows = [(node('settings-title', title), 0)]
            if not missing:
                rows.append((node('open-settings', label), 0))
            return rows
        env.update(apps=lambda: [SimpleNamespace(get_process_id=lambda: pid)], nodes=nodes)
        def wait_for(_, test):
            if not test():
                raise RuntimeError('Back did not return')
        env['wait_for'] = wait_for
        return env, action

    def test_run34_retained_action_inventory_returns_to_owned_view(self):
        # run34/desktop-account-e2e-Linux-X64/desktop-e2e-lifecycle/
        # 1794467881072715805-settings-back-failure.json, settingsBackAction.
        inventory = {'nActions': 1, 'actions': [{'index': 0, 'name': 'press'}],
                     'errors': []}
        env, action = self.environment(pid=27462)
        env['args'] = SimpleNamespace(pid=27462, start_time='100066')
        action.nActions = inventory['nActions']
        action.getName = lambda index: inventory['actions'][index]['name']
        env['settings_back']()
        action.doAction.assert_called_once_with(0)
        self.assertEqual(env['report'], {'title': 'Settings', 'label': 'Back'})
        self.assertEqual(env['verify'].call_count, 4)

    def test_back_accessible_name_with_unsupported_text_returns_to_owned_view(self):
        env, action = self.environment()
        button = env['dom_node']('open-settings')
        original_nodes = env['nodes']
        env['nodes'] = lambda app: [(button if node.getAttributes() == ['id:open-settings']
                                    else node, depth) for node, depth in original_nodes(app)]
        env['settings_back']()
        button.queryText.assert_not_called()
        action.doAction.assert_called_once_with(0)
        self.assertEqual(env['report'], {'title': 'Settings', 'label': 'Back'})
        self.assertEqual(env['verify'].call_count, 4)

    def test_invalid_or_foreign_settings_refuses_native_action(self):
        for options in [dict(title='Other'), dict(label='Settings'), dict(enabled=False),
                        dict(pid=999), dict(missing=True), dict(visible=False),
                        dict(showing=False), dict(role='label')]:
            with self.subTest(options=options):
                env, action = self.environment(**options)
                with self.assertRaises(RuntimeError):
                    env['settings_back']()
                action.doAction.assert_not_called()
                self.assertNotIn('label', env['report'])

    def test_wrong_accessible_name_refuses_even_when_text_says_back(self):
        for label in ['Settings', '', ' Back', 'Back ', 'back']:
            with self.subTest(label=label):
                env, action = self.environment(label=label, button_text='Back')
                with self.assertRaisesRegex(RuntimeError, 'enabled Back button'):
                    env['settings_back']()
                action.doAction.assert_not_called()
                self.assertNotIn('label', env['report'])

    def test_heading_still_requires_text_not_accessible_name(self):
        env, action = self.environment()
        original = env['nodes']
        def without_heading_text(app):
            rows = original(app)
            rows[0][0].name = 'Settings'
            rows[0][0].queryText = Mock(side_effect=NotImplementedError('heading Text unsupported'))
            return rows
        env['nodes'] = without_heading_text
        with self.assertRaisesRegex(NotImplementedError, 'heading Text unsupported'):
            env['settings_back']()
        action.doAction.assert_not_called()

    def test_birth_failure_refuses_native_action(self):
        env, action = self.environment()
        env['verify'].side_effect = [None, RuntimeError('birth mismatch')]
        with self.assertRaisesRegex(RuntimeError, 'birth mismatch'):
            env['settings_back']()
        action.doAction.assert_not_called()

    def test_duplicate_back_refuses_native_action(self):
        env, action = self.environment()
        original = env['nodes']
        env['nodes'] = lambda app: original(app) + original(app)[1:]
        with self.assertRaisesRegex(RuntimeError, 'open-settings, found 2'):
            env['settings_back']()
        action.doAction.assert_not_called()

    def test_failed_native_press_does_not_report_success(self):
        env, action = self.environment()
        action.doAction = Mock(return_value=False)
        with self.assertRaisesRegex(RuntimeError, 'native press failed'):
            env['settings_back']()
        action.doAction.assert_called_once_with(0)
        self.assertNotIn('label', env['report'])

    def test_missing_native_press_refused(self):
        env, action = self.environment()
        action.getName = lambda _: 'other'
        with self.assertRaisesRegex(RuntimeError, 'one native press action'):
            env['settings_back']()
        action.doAction.assert_not_called()

    def test_refused_action_inventories_without_input(self):
        for names in [['click'], ['press', 'press'], []]:
            with self.subTest(names=names):
                env, action = self.environment()
                env['report']['before'] = '/owned/settings-back-before.json'
                action.nActions = len(names)
                action.getName = Mock(side_effect=lambda index: names[index])
                with self.assertRaisesRegex(RuntimeError, 'one native press action'):
                    env['settings_back']()
                receipt = env['report']['settingsBackAction']
                self.assertEqual(receipt['nActions'], len(names))
                self.assertEqual(receipt['actions'], [
                    {'index': index, 'name': name} for index, name in enumerate(names)])
                self.assertEqual(receipt['pid'], 27243)
                self.assertEqual(receipt['appPid'], 27243)
                self.assertEqual(receipt['startTime'], '74143')
                self.assertEqual(receipt['beforeTree'], env['report']['before'])
                self.assertEqual(receipt['controlId'], 'open-settings')
                self.assertEqual(receipt['name'], 'Back')
                self.assertEqual(receipt['role'], 'push button')
                self.assertIn('id:open-settings', receipt['attributes'])
                self.assertEqual(receipt['errors'], [])
                action.doAction.assert_not_called()

    def test_diagnostic_name_error_preserves_refusal(self):
        env, action = self.environment()
        action.getName = Mock(side_effect=['click', RuntimeError('native name unreadable')])
        with self.assertRaisesRegex(RuntimeError, 'one native press action'):
            env['settings_back']()
        self.assertEqual(env['report']['settingsBackAction']['actions'], [
            {'index': 0, 'error': 'native name unreadable'}])
        action.doAction.assert_not_called()

    def test_diagnostic_count_and_control_errors_preserve_refusal(self):
        env, action = self.environment()
        reads = iter([1, RuntimeError('native count unreadable')])

        class ChangingAction:
            @property
            def nActions(self):
                value = next(reads)
                if isinstance(value, Exception):
                    raise value
                return value

            getName = staticmethod(lambda _: 'click')
            doAction = action.doAction

        rows = env['nodes'](None)
        env['nodes'] = lambda _: rows
        button = rows[1][0]
        button.queryAction = lambda: ChangingAction()
        button.getAttributes = Mock(side_effect=[
            ['id:open-settings'], ['id:open-settings'],
            RuntimeError('attributes unreadable')])
        with self.assertRaisesRegex(RuntimeError, 'one native press action'):
            env['settings_back']()
        receipt = env['report']['settingsBackAction']
        self.assertEqual(receipt['errors'], [
            {'field': 'attributes', 'error': 'attributes unreadable'},
            {'field': 'nActions', 'error': 'native count unreadable'}])
        self.assertNotIn('nActions', receipt)
        self.assertEqual(receipt['actions'], [])
        action.doAction.assert_not_called()


class PointerTests(unittest.TestCase):
    def run_click(self, readings):
        source = ast.parse(Path(__file__).with_name('lifecycle-linux.py').read_text())
        functions = ast.Module(body=[n for n in source.body if isinstance(n, ast.FunctionDef)],
                               type_ignores=[])
        clock = SimpleNamespace(now=0.0)
        def sleep(seconds):
            clock.now += seconds
        time = SimpleNamespace(monotonic=lambda: clock.now, sleep=sleep, time_ns=lambda: 0)
        rect = SimpleNamespace(x=14, y=0, width=22, height=32)
        node = SimpleNamespace(name='', getRoleName=lambda: 'push button',
                               getState=lambda: SimpleNamespace(contains=lambda _: True),
                               queryComponent=lambda: SimpleNamespace(getExtents=lambda _: rect))
        app = SimpleNamespace(get_process_id=lambda: 2)
        calls = []
        def run(argv, **kwargs):
            if argv[1] == 'getmouselocation':
                return subprocess.CompletedProcess(argv, 0, command(*argv), '')
            calls.append((argv, kwargs))
            if '--sync' in argv:
                raise subprocess.TimeoutExpired(argv, 10)
            return subprocess.CompletedProcess(argv, 0, '', '')
        values = iter(readings)
        last = readings[-1]
        def command(*argv):
            nonlocal last
            last = next(values, last)
            return last
        env = {'subprocess': SimpleNamespace(run=run, TimeoutExpired=subprocess.TimeoutExpired),
               'time': time, 'args': SimpleNamespace(pid=1, start_time='a', panel_pid=2,
                                                   panel_start_time='b'),
               'report': {}, 'pyatspi': SimpleNamespace(STATE_SHOWING=1, STATE_VISIBLE=2,
                                                        DESKTOP_COORDS=0)}
        exec(compile(functions, '<real lifecycle functions>', 'exec'), env)
        env.update(apps=lambda: [app], nodes=lambda _: [(node, 0)], verify=Mock(),
                   save=Mock(), command=command)
        error = None
        try:
            env['click_unique']({2}, {''}, {'push button'}, button=3)
        except Exception as caught:
            error = caught
        return env, calls, clock.now, error

    def test_already_at_target_skips_move_and_clicks(self):
        env, calls, _, error = self.run_click(['X=25\nY=16\nSCREEN=0\nWINDOW=1\n'])
        self.assertIsNone(error)
        self.assertEqual([c[0] for c in calls], [['xdotool', 'click', '3']])
        self.assertEqual(env['report']['indicatorInput']['phases'][0]['state'], 'completed')
        self.assertGreaterEqual(env['verify'].call_count, 6)

    def test_moves_without_sync_and_waits_for_target(self):
        _, calls, _, error = self.run_click(['X=0\nY=0\n', 'X=1\nY=1\n', 'X=25\nY=16\n'])
        self.assertIsNone(error)
        self.assertEqual(calls[0][0], ['xdotool', 'mousemove', '25', '16'])
        self.assertEqual(calls[-1][0], ['xdotool', 'click', '3'])

    def test_stuck_pointer_fails_closed(self):
        env, calls, elapsed, error = self.run_click(['X=0\nY=0\n'])
        self.assertIsNotNone(error)
        self.assertLessEqual(elapsed, 2.1)
        self.assertFalse(any(c[0][1] == 'click' for c in calls))
        self.assertEqual(env['report']['indicatorInput']['phases'][0]['state'], 'timeout')

    def test_malformed_poll_refuses_click_and_retains_reply(self):
        env, calls, _, error = self.run_click(['X=0\nY=0\n', 'bad reply'])
        self.assertIsNotNone(error)
        self.assertEqual([c[0] for c in calls], [['xdotool', 'mousemove', '25', '16']])
        phase = env['report']['indicatorInput']['phases'][0]
        self.assertEqual(phase['state'], 'failed')
        self.assertEqual(phase['pointerAfter']['value'], 'bad reply')

    def test_malformed_pointer_fails_closed(self):
        for value in ['garbage', 'X=25\nY=no\n', 'X=25\nX=25\nY=16\n']:
            with self.subTest(value=value):
                env, calls, _, error = self.run_click([value])
                self.assertIsNotNone(error)
                self.assertEqual(calls, [])
                self.assertEqual(env['report']['indicatorInput']['phases'][0]['state'], 'failed')


if __name__ == '__main__':
    unittest.main()
