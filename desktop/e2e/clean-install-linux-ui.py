import json
import sys
from http.client import HTTPConnection
from urllib.parse import urlsplit

import pyatspi


def descendants(element):
    yield element
    for child in element:
        if child is not None:
            yield from descendants(child)


def attributes(element):
    return dict(item.split(':', 1) for item in element.getAttributes() if ':' in item)


def main():
    operation, *args = sys.argv[1:]
    if operation == 'open':
        url = urlsplit(args[0])
        if url.scheme != 'http' or url.hostname != '127.0.0.1' or url.path not in ('/approve', '/machines'):
            return
        connection = HTTPConnection(url.hostname, url.port, timeout=10)
        try:
            connection.request('GET', url.path)
            assert connection.getresponse().status == 200, 'The loopback page did not answer.'
        finally:
            connection.close()
        return
    apps = [node for node in pyatspi.Registry.getDesktop(0) if node.name in ('cotal-desktop', 'Cotal')]
    if operation == 'describe':
        print(json.dumps({'visible': any(window.getState().contains(pyatspi.STATE_SHOWING) for app in apps for window in app)}))
        return
    assert len(apps) == 1, 'Expected one installed Cotal application.'
    target, *values = args
    labels = {
        'other-host': 'Use another Cotal host', 'provider': 'Cotal host sign-in URL',
        'login': 'Continue in browser', 'dashboard': 'Open dashboard', 'details': 'Details',
    }
    matches = [node for node in descendants(apps[0]) if attributes(node).get('id') == target]
    if not matches and target in labels:
        matches = [node for node in descendants(apps[0]) if node.name == labels[target]]
    visible = [node for node in matches if node.getState().contains(pyatspi.STATE_SHOWING)]
    assert len(visible) == 1, f'Expected one visible {target} control.'
    node = visible[0]
    if operation == 'click':
        action = node.queryAction()
        choices = [i for i in range(action.nActions) if action.getName(i) in ('click', 'press', 'activate')]
        assert choices and action.doAction(choices[0]), f'Could not activate {target}.'
        print('true')
    elif operation == 'fill':
        assert node.queryEditableText().setTextContents(values[0]), f'Could not enter {target}.'
        print('true')
    elif operation == 'text':
        print(json.dumps(node.queryText().getText(0, -1)))
    else:
        raise ValueError('Unsupported desktop accessibility operation.')


if __name__ == '__main__':
    main()
