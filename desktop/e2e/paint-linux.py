import ctypes as C
import json
import os
from pathlib import Path
import struct
import sys
import time
import zlib

pid_file, ready_file, output = map(Path, sys.argv[1:])
x = C.CDLL('libX11.so.6')
Window = C.c_ulong
class Attributes(C.Structure):
    _fields_ = [('x', C.c_int), ('y', C.c_int), ('width', C.c_int), ('height', C.c_int), ('border', C.c_int), ('depth', C.c_int), ('visual', C.c_void_p), ('root', Window), ('class_', C.c_int), ('bit_gravity', C.c_int), ('win_gravity', C.c_int), ('backing_store', C.c_int), ('backing_planes', C.c_ulong), ('backing_pixel', C.c_ulong), ('save_under', C.c_int), ('colormap', Window), ('map_installed', C.c_int), ('map_state', C.c_int), ('all_event_masks', C.c_long), ('your_event_mask', C.c_long), ('do_not_propagate_mask', C.c_long), ('override_redirect', C.c_int), ('screen', C.c_void_p)]
x.XOpenDisplay.argtypes = [C.c_char_p]; x.XOpenDisplay.restype = C.c_void_p
x.XDefaultRootWindow.argtypes = [C.c_void_p]; x.XDefaultRootWindow.restype = Window
x.XQueryTree.argtypes = [C.c_void_p, Window, C.POINTER(Window), C.POINTER(Window), C.POINTER(C.POINTER(Window)), C.POINTER(C.c_uint)]
x.XFetchName.argtypes = [C.c_void_p, Window, C.POINTER(C.c_char_p)]
x.XGetWindowAttributes.argtypes = [C.c_void_p, Window, C.POINTER(Attributes)]
x.XGetImage.argtypes = [C.c_void_p, Window, C.c_int, C.c_int, C.c_uint, C.c_uint, C.c_ulong, C.c_int]; x.XGetImage.restype = C.c_void_p
x.XGetPixel.argtypes = [C.c_void_p, C.c_int, C.c_int]; x.XGetPixel.restype = C.c_ulong
x.XDestroyImage.argtypes = [C.c_void_p]
x.XFree.argtypes = [C.c_void_p]
display = x.XOpenDisplay(None)
if not display:
    raise RuntimeError('Owned X11 display unavailable')
root = x.XDefaultRootWindow(display)
def windows(parent):
    r, p, children, count = Window(), Window(), C.POINTER(Window)(), C.c_uint()
    if not x.XQueryTree(display, parent, C.byref(r), C.byref(p), C.byref(children), C.byref(count)):
        return []
    result = list(children[:count.value])
    if children: x.XFree(children)
    return result

def target():
    for w in windows(root):
        name = C.c_char_p()
        if not x.XFetchName(display, w, C.byref(name)): continue
        title = name.value
        x.XFree(C.cast(name, C.c_void_p))
        a = Attributes()
        if title == b'Cotal' and x.XGetWindowAttributes(display, w, C.byref(a)) and a.map_state == 2 and a.width >= 400 and a.height >= 300:
            return w, a
    return None

def png(path, image, width, height):
    data = bytearray()
    for y in range(height):
        data.append(0)
        for xx in range(width):
            pixel = x.XGetPixel(image, xx, y)
            data.extend(((pixel >> 16) & 255, (pixel >> 8) & 255, pixel & 255))
    def chunk(kind, value):
        return struct.pack('!I', len(value)) + kind + value + struct.pack('!I', zlib.crc32(kind + value))
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(data)) + chunk(b'IEND', b''))

ready_file.write_text('ready')
while not pid_file.exists(): time.sleep(.005)
pid = int(pid_file.read_text())
stat = (Path('/proc') / str(pid) / 'stat').read_text().rsplit(')', 1)[1].split()
process_start = int(stat[19]) / os.sysconf('SC_CLK_TCK')
start = time.monotonic()
report = {'platform': 'linux', 'method': 'X11 viewable Cotal window on exclusive test display, XGetImage RGB header pixels', 'precision': 'Sampling intervals and capture durations are recorded. First visible sample is an upper bound, not an OS presentation timestamp. Process start uses proc start ticks and CLOCK_BOOTTIME, with tick precision.', 'samples': [], 'outcome': 'timeout', 'anyFrameNeitherPaperNorContent': False}
first_image = None
last_image = None
try:
    while time.monotonic() - start < 45:
        os.kill(pid, 0)
        found = target()
        at = (time.monotonic() - start) * 1000
        if found:
            window, a = found
            if 'visibleAtMs' not in report:
                report.update(visibleAtMs=at, processStartToVisibleMs=(time.clock_gettime(time.CLOCK_BOOTTIME) - process_start) * 1000, window=window, bounds=[a.x, a.y, a.width, a.height])
            # Capture only the header crop so sampling itself does not serialize full PNGs.
            image = x.XGetImage(display, window, 0, 0, min(a.width, 180), min(a.height, 150), C.c_ulong(-1).value, 2)
            if not image: raise RuntimeError('XGetImage refused header capture')
            count = 0
            paper = 0
            pixels = 0
            for yy in range(10, 150, 2):
                for xx in range(0, 180, 2):
                    pixel = x.XGetPixel(image, xx, yy)
                    rgb = [(pixel >> 16) & 255, (pixel >> 8) & 255, pixel & 255]
                    if max(rgb) - min(rgb) > 60 and max(rgb) > 140: count += 1
                    pixels += 1
                    if all(abs(c - expected) <= 5 for c, expected in zip(rgb, [255, 252, 238])): paper += 1
            captured = (time.monotonic() - start) * 1000
            neither = count < 8 and paper / pixels < .9
            report['anyFrameNeitherPaperNorContent'] |= neither
            report['samples'].append({'atMs': at, 'capturedAtMs': captured, 'logoPixels': count, 'paperFraction': paper / pixels, 'neitherPaperNorContent': neither})
            if first_image is None: first_image = image
            elif last_image is not None: x.XDestroyImage(last_image)
            last_image = image if image != first_image else None
            if count >= 8:
                report.update(paintedAtMs=captured, visibleToPaintMs=captured - report['visibleAtMs'], outcome='painted')
                png(output / 'first-painted.png', image, 180, 150)
                break
        time.sleep(.01)
    if first_image: png(output / 'first-visible.png', first_image, 180, 150)
finally:
    (output / 'first-paint.json').write_text(json.dumps(report, indent=2))
    if first_image: x.XDestroyImage(first_image)
    if last_image: x.XDestroyImage(last_image)
if report['outcome'] != 'painted': raise RuntimeError('No visible header paint within 45 seconds')
