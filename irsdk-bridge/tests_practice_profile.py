import os
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import practice_profile


def make_ibt(session_yaml, records):
    si = session_yaml.encode('utf-8')
    si_off = 112
    vh_off = si_off + len(si) + 16
    data_off = vh_off + 2 * 144
    row_size = 12
    raw = bytearray(data_off + row_size * len(records))
    struct.pack_into('<i', raw, 16, len(si)); struct.pack_into('<i', raw, 20, si_off)
    raw[si_off:si_off + len(si)] = si
    struct.pack_into('<i', raw, 24, 2); struct.pack_into('<i', raw, 28, vh_off)
    struct.pack_into('<i', raw, 36, row_size); struct.pack_into('<i', raw, 52, data_off)
    for i, (name, offset) in enumerate((('TrackTempCrew', 0), ('LapLastLapTime', 4))):
        at = vh_off + i * 144
        struct.pack_into('<iii', raw, at, 4, offset, 1)
        raw[at + 16:at + 16 + len(name)] = name.encode()
    for i, (temp, lap) in enumerate(records):
        struct.pack_into('<ff', raw, data_off + i * row_size, temp, lap)
    return raw


class PracticeProfileTests(unittest.TestCase):
    def test_reads_user_ibt_without_retaining_raw_samples(self):
        yaml = '''WeekendInfo:\n  TrackDisplayName: Suzuka Circuit\nDriverInfo:\n  DriverCarIdx: 0\n  Drivers:\n  - CarIdx: 0\n    CarScreenName: Ferrari 296 GT3\n    CarClassShortName: GT3\nSessionInfo:\n  Sessions:\n  - SessionType: Practice\nCarSetup:\n  Chassis:\n    RearWing: 6\n'''
        with tempfile.NamedTemporaryFile(suffix='.ibt', delete=False) as f:
            f.write(make_ibt(yaml, [(31.0, -1), (32.0, 122.5), (33.0, 121.8), (34.0, 122.1)])); path = f.name
        try:
            p = practice_profile.read_ibt_profile(path)
        finally:
            os.unlink(path)
        self.assertEqual(p['identity']['track'], 'Suzuka Circuit')
        self.assertEqual(p['identity']['car_model'], 'Ferrari 296 GT3')
        self.assertTrue(p['identity']['setup_available'])
        self.assertEqual(p['practice_track_temp_c']['median'], 32.5)
        self.assertEqual(p['practice_lap_time_s']['min'], 121.8)
        self.assertNotIn('records', p)

    def test_selected_sto_overrides_embedded_setup(self):
        yaml = '''WeekendInfo:\n  TrackName: Suzuka\nDriverInfo:\n  DriverCarIdx: 0\n  Drivers:\n  - CarIdx: 0\n    CarScreenName: GT3\n'''
        with tempfile.NamedTemporaryFile(suffix='.ibt', delete=False) as f:
            f.write(make_ibt(yaml, [])); ibt = f.name
        with tempfile.NamedTemporaryFile(suffix='.sto', mode='w', delete=False) as f:
            f.write('Chassis:\n  RearWing: 7\n'); sto = f.name
        try:
            p = practice_profile.read_ibt_profile(ibt, sto)
        finally:
            os.unlink(ibt); os.unlink(sto)
        self.assertEqual(p['identity']['setup_source'], 'selected_sto')
        self.assertTrue(p['identity']['setup_fingerprint'])


if __name__ == '__main__':
    unittest.main()
