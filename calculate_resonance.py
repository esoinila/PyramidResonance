import math

def calculate_resonant_frequencies(L, W, H, v=1126, max_mode=5, max_freq=100):
    frequencies = []
    for nx in range(0, max_mode+1):
        for ny in range(0, max_mode+1):
            for nz in range(0, max_mode+1):
                if nx == ny == nz == 0:
                    continue
                f = (v / 2) * math.sqrt((nx / L)**2 + (ny / W)**2 + (nz / H)**2)
                if f <= max_freq:
                    frequencies.append(round(f, 2))
    frequencies.sort()
    return list(set(frequencies))

# Example usage
# Khufu (King's Chamber): 34.36, 17.19, 19.20 ft
khufu_dims = (34.36, 17.19, 19.20)
# Khafre (Burial Chamber): 46.5, 16.5, 22.5 ft
khafre_dims = (46.5, 16.5, 22.5)
# Menkaure (Burial Chamber): 21.88, 8.67, 11.5 ft
menkaure_dims = (21.88, 8.67, 11.5)

print("Khufu (King's Chamber):", calculate_resonant_frequencies(*khufu_dims))
print("\nKhafre:", calculate_resonant_frequencies(*khafre_dims))
print("\nMenkaure:", calculate_resonant_frequencies(*menkaure_dims))
