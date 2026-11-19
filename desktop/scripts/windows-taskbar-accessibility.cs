using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using Accessibility;

public static class ExplorerTaskbarAccessibility {
    private const uint OBJID_CLIENT = unchecked((uint)-4);
    private const int CHILDID_SELF = 0;
    private const int ROLE_SYSTEM_PUSHBUTTON = 0x2b;
    private const int STATE_SYSTEM_INVISIBLE = 0x8000;
    private const int STATE_SYSTEM_OFFSCREEN = 0x10000;

    private delegate bool EnumChildProc(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr hwnd, EnumChildProc callback, IntPtr data);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder name, int length);
    [DllImport("oleacc.dll")] private static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IAccessible accessible);
    [DllImport("oleacc.dll")] private static extern int AccessibleChildren(IAccessible container, int start, int count, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 2, ArraySubType = UnmanagedType.Struct)] object[] children, out int obtained);

    public sealed class Button {
        public string Name { get; set; }
        public int ChildId { get; set; }
    }

    public static IntPtr RunningApps(IntPtr taskbar) {
        var matches = new List<IntPtr>();
        EnumChildWindows(taskbar, (hwnd, _) => {
            var name = new StringBuilder(64);
            if (IsWindowVisible(hwnd) && GetClassName(hwnd, name, name.Capacity) > 0 && name.ToString() == "MSTaskListWClass")
                matches.Add(hwnd);
            return true;
        }, IntPtr.Zero);
        if (matches.Count != 1) throw new InvalidOperationException("Expected one visible Explorer running-app toolbar, found " + matches.Count + ".");
        return matches[0];
    }

    public static Button[] Buttons(IntPtr toolbar) {
        var iid = typeof(IAccessible).GUID;
        int result = AccessibleObjectFromWindow(toolbar, OBJID_CLIENT, ref iid, out IAccessible root);
        Marshal.ThrowExceptionForHR(result);
        if (root == null) throw new InvalidOperationException("Explorer did not return a running-app client object.");
        var buttons = new List<Button>();
        try {
            int remaining = 128;
            Visit(root, CHILDID_SELF, buttons, 0, ref remaining);
        } finally { Marshal.ReleaseComObject(root); }
        return buttons.ToArray();
    }

    private static void Visit(IAccessible accessible, int child, List<Button> buttons, int depth, ref int remaining) {
        if (--remaining < 0 || depth > 8) throw new InvalidOperationException("Explorer running-app accessibility tree exceeded its inspection bound.");
        if (accessible.get_accRole(child) is int role && role == ROLE_SYSTEM_PUSHBUTTON &&
            accessible.get_accState(child) is int state && (state & (STATE_SYSTEM_INVISIBLE | STATE_SYSTEM_OFFSCREEN)) == 0) {
            buttons.Add(new Button { Name = accessible.get_accName(child), ChildId = child });
        }
        if (child != CHILDID_SELF) return;
        int count = accessible.accChildCount;
        if (count == 0) return;
        if (count < 0 || count > remaining) throw new InvalidOperationException("Explorer returned too many running-app children.");
        var children = new object[count];
        try {
            Marshal.ThrowExceptionForHR(AccessibleChildren(accessible, 0, count, children, out int obtained));
            if (obtained != count) throw new InvalidOperationException("Explorer running-app children changed during enumeration.");
            foreach (var item in children) {
                if (item is int id && id > 0) Visit(accessible, id, buttons, depth + 1, ref remaining);
                else if (item is IAccessible node) Visit(node, CHILDID_SELF, buttons, depth + 1, ref remaining);
                else throw new InvalidOperationException("Explorer returned an unknown running-app child.");
            }
        } finally {
            foreach (var item in children)
                if (item != null && Marshal.IsComObject(item)) Marshal.ReleaseComObject(item);
        }
    }
}
