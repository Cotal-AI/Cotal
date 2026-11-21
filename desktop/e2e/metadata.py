import json
import sys
import pyatspi

pid = int(sys.argv[1])
rows = []
def walk(node, depth=0):
    if depth > 24:
        return
    try:
        rows.append({"name": node.name, "role": node.getRoleName(), "text": node.queryText().getText(0, -1) if node.getState().contains(pyatspi.STATE_VISIBLE) or node.getRoleName() == "text" else ""})
    except Exception:
        rows.append({"name": node.name, "role": node.getRoleName()})
    for child in node:
        walk(child, depth + 1)
for app in pyatspi.Registry.getDesktop(0):
    if app.get_process_id() == pid:
        walk(app)
print(json.dumps(rows))
if not rows:
    sys.exit("AT-SPI exposes no application for the owned PID")
