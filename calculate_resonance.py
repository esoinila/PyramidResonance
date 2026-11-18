"""Room modes of a rigid rectangular chamber. Same maths as modes.js, for checking by hand."""
import math

INCH, FOOT = 0.0254, 0.3048


def speed_of_sound(temp_c=20.0):
    """Dry air, m/s. 20 C gives 343.2 m/s (1126 ft/s)."""
    return 331.3 * math.sqrt(1 + temp_c / 273.15)


def room_modes(length, width, height, c=None, f_min=0.0, f_max=250.0):
    """All modes between f_min and f_max as sorted (frequency, (nx, ny, nz)) pairs. Metres and hertz."""
    c = speed_of_sound() if c is None else c
    out = []
    for nx in range(int(2 * length * f_max / c) + 1):
        for ny in range(int(2 * width * f_max / c) + 1):
            for nz in range(int(2 * height * f_max / c) + 1):
                if nx == ny == nz == 0:
                    continue
                f = (c / 2) * math.sqrt((nx / length) ** 2 + (ny / width) ** 2 + (nz / height) ** 2)
                if f_min <= f <= f_max:
                    out.append((f, (nx, ny, nz)))
    return sorted(out)


ROOMS = {
    # Petrie 1883 means: 412.35 x 206.26 x 230.39 inches
    "Khufu (King's Chamber)": (412.35 * INCH, 206.26 * INCH, 230.39 * INCH),
    "Khafre (burial chamber, gabled)": (46.5 * FOOT, 16.5 * FOOT, 22.5 * FOOT),
    "Menkaure (burial chamber, vaulted)": (21.88 * FOOT, 8.67 * FOOT, 11.5 * FOOT),
}

if __name__ == "__main__":
    for name, dims in ROOMS.items():
        axial = [(f, n) for f, n in room_modes(*dims, f_min=60) if sum(1 for k in n if k) == 1]
        print(name, "axial modes 60-250 Hz:")
        print("  " + ", ".join(f"{f:.1f}" for f, _ in axial))
