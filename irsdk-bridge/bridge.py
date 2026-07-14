"""
OMORAY PITWALL - iRacing Bridge  BUILD 2026-07-04-039
Reads iRacing shared memory directly
Features: lap times, personal best, tire temps, iRating, SOF, Safety Rating, track info
Requires: pip install websockets
Usage: python bridge.py
"""

import asyncio
import os
import sys
import json
import mmap
import ctypes
from ctypes import wintypes
import struct
import time
import math
import random
from datetime import datetime
import threading
import websockets

# ⚠️標準出力/エラーをutf-8に。Windowsコンソールはcp932で、Lunaの返答に含まれる — や · 等を
#   printするとUnicodeEncodeErrorで落ちていた（2026/7/7の接続断の主因）。またmain.js(Electron)は
#   bridgeのstdoutをそのままデバッグログに書くため、cp932化けが「?」としてログに残る問題もあった。
#   utf-8に固定すれば print が落ちず、ログにも正しい日本語が残る（errors=replaceで最後の保険）。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

IRSDK_MEMMAPFILE = "Local\\IRSDKMemMapFileName"
MEM_SIZE = 1164 * 1024
FILE_MAP_READ = 0x0004

try:
    _k32 = ctypes.windll.kernel32
    _k32.OpenFileMappingW.restype = wintypes.HANDLE
    _k32.OpenFileMappingW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
    _k32.MapViewOfFile.restype = ctypes.c_void_p
    _k32.MapViewOfFile.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, ctypes.c_size_t]
    _k32.UnmapViewOfFile.argtypes = [ctypes.c_void_p]
    _k32.CloseHandle.argtypes = [wintypes.HANDLE]
except Exception:
    _k32 = None

# ⚠️ビルドを更新したらここを必ず変える（ログでexe版を判別するため。今まで固定で混乱の元だった）。
BUILD_VERSION = "2026-07-07-B (gap/fuel/autoflow/stream)"
PORT = 8765
connected_clients = set()
loop = None

# ログは実行ファイル（exe/py）と同じ場所に書く（どこに置いても動く）
try:
    _base = os.path.dirname(os.path.abspath(sys.argv[0])) or os.getcwd()
except Exception:
    _base = "."
LOG_PATH = os.path.join(_base, "bridge_log.txt")

# ⚠️PTT/音量設定は実行ファイルと同じ場所ではなく、OS標準の永続フォルダに保存する。
# desktop版はportable形式で毎回ランダムな一時フォルダに展開されるため、_base基準だと
# 設定ファイルも使い捨てフォルダに書かれ、次回起動時には消えている（設定が復元されない不具合の原因）。
try:
    _appdata = os.environ.get("APPDATA") or os.path.expanduser("~")
    _config_dir = os.path.join(_appdata, "OMORAY-PITWALL")
    os.makedirs(_config_dir, exist_ok=True)
except Exception:
    _config_dir = _base
PTT_CONFIG_PATH = os.path.join(_config_dir, "ptt_config.json")
VOL_CONFIG_PATH = os.path.join(_config_dir, "vol_config.json")

# ── PTT（プッシュ・トゥ・トーク）状態 ──
ptt_binding = None        # {"joy": int, "button": int, "name": str}
ptt_capturing = False     # 設定モード（次に押されたボタンを登録）
ptt_pressed = False       # 現在押下中か
ptt_lang = "ja-JP"        # STT言語（選択キャラに追従。English勢=en-GB/en-US、日本語勢=ja-JP）
ptt_mismatch_warned = False  # 登録デバイスが見つからない事を通知済みか（毎スキャンで連呼しない）

# ── 音量ボタン（ステアリングのダイヤル/ボタンで走行中に音量上下）──
vol_binding = {"up": None, "down": None}   # 各 {"joy": int, "button": int}
vol_capturing = None       # 設定モード中の対象 'up' | 'down' | None
vol_pressed = {"up": False, "down": False} # 各方向の現在押下状態（エッジ検出用）

def load_ptt_config():
    global ptt_binding
    try:
        with open(PTT_CONFIG_PATH, "r", encoding="utf-8") as f:
            ptt_binding = json.load(f)
    except Exception:
        ptt_binding = None

def save_ptt_config():
    try:
        with open(PTT_CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(ptt_binding, f)
    except Exception:
        pass

def load_vol_config():
    global vol_binding
    try:
        with open(VOL_CONFIG_PATH, "r", encoding="utf-8") as f:
            d = json.load(f)
            if isinstance(d, dict):
                vol_binding = {"up": d.get("up"), "down": d.get("down")}
    except Exception:
        vol_binding = {"up": None, "down": None}

def save_vol_config():
    try:
        with open(VOL_CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(vol_binding, f)
    except Exception:
        pass

TTS_API_KEY = ""  # bridgeはRailway STT proxyを使うので空でもOK（直接Google API呼ばない場合）

RAILWAY_URL = "https://www.omoraypitwall.com"

# コーナー単位サイドバイサイド検知の舵角しきい値（ラジアン）。
# ⚠️車種でステアリング比が違う(GT3は切れ角大、フォーミュラは小さい)ため固定値の限界あり。
# 実走テストで誤検知/未検知が出たら、この2値をチューニングする(Yuji方針・2026-07-14)。
CORNER_ENTRY_RAD = 0.10   # 約5.7度。これを超えたら「コーナー進入」候補
CORNER_EXIT_RAD = 0.04    # 約2.3度。これを下回ったら「コーナー脱出」候補（ヒステリシスで閾値付近のふらつき対策）

# シリーズ固有のクラス略称を、口頭で分かりやすい一般的なカテゴリー名に変換する
# （例：IMSA23シリーズのGT3規定クラスは"IMSA23"という略称だが、喋る時は"GT3"の方が伝わる）。
# ⚠️他シリーズで同様に分かりにくい略称が出てきたら随時ここに追加する(Yuji方針・2026-07-14)。
CLASS_NAME_ALIASES = {'IMSA23': 'GT3'}

def _norm_class_name(name):
    return CLASS_NAME_ALIASES.get(name, name) if name else name

_ORDINALS_EN = {1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th'}

def _class_id_txt_en(class_name, class_pos):
    label = _norm_class_name(class_name) or 'faster class'
    if class_pos and 1 <= class_pos <= 5:
        return label + ' ' + _ORDINALS_EN[class_pos] + ' car'
    return label + ' class'

def _fmt_gap(g):
    # 車間秒数の読み上げ用フォーマット。ぴったりの数字(9.0/10.0)は小数点を出さない
    # （「9秒」でなく「9.0秒」とTTSが律儀に読んでしまう問題への対応・Yuji指摘2026-07-14）。
    r = round(g, 1)
    return str(int(r)) if r == int(r) else str(r)

def _catchup_stage_of(g):
    # 段階的キャッチアップ/ディフェンスコールの距離帯判定（10/7/3/1.5秒）
    if g <= 1.5: return 4
    if g <= 3.0: return 3
    if g <= 7.0: return 2
    if g <= 10.0: return 1
    return 0

def log(msg):
    line = "[" + datetime.now().strftime("%H:%M:%S") + "] " + msg
    # ⚠️Windowsコンソールはcp932。会話ログ(Lunaの返答)に含まれる — や · 等cp932に無い文字を
    #   printするとUnicodeEncodeErrorが発生し、呼び出し元のWS接続ハンドラごとクラッシュ→
    #   ブラウザ切断→「Connection error」の主因だった(2026/7/7判明)。printを絶対に例外で
    #   落とさないよう保護する。ファイル(utf-8)には完全な文字列を残す。
    try:
        print(line, flush=True)
    except Exception:
        try:
            print(line.encode("ascii", "replace").decode("ascii"), flush=True)
        except Exception:
            pass
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass

# ── マイク入力（PTT用・ネイティブキャプチャ）──
# pyaudioでマイクから直接音声をキャプチャ（フルスクリーン背後でも動作）
ptt_audio = None
ptt_recording = False

def init_mic():
    global ptt_audio
    try:
        import pyaudio
        ptt_audio = pyaudio.PyAudio()
        log("PTT: pyaudio initialized")
        return True
    except Exception as e:
        log("PTT: pyaudio init failed - " + str(e))
        return False

def start_ptt_record():
    global ptt_recording
    if not ptt_audio:
        return
    ptt_recording = True
    log("PTT: recording started (native pyaudio)")

def stop_ptt_record():
    global ptt_recording
    if not ptt_recording:
        return
    ptt_recording = False
    log("PTT: recording stopped, sending to STT...")

def record_ptt_audio():
    """バックグラウンドスレッド：マイク入力をキャプチャ＆STT送信"""
    if not ptt_audio:
        log("PTT record: pyaudio not initialized, skipping")
        return
    try:
        import pyaudio
        import base64
        import wave

        CHUNK = 1024
        FORMAT = pyaudio.paInt16   # LINEAR16 = Google STT互換（Float32ではない）
        CHANNELS = 1
        RATE = 16000

        stream = ptt_audio.open(format=FORMAT, channels=CHANNELS, rate=RATE,
                                input=True, frames_per_buffer=CHUNK)
        frames = []
        log("PTT: mic stream open, ready to record")

        while True:
            if ptt_recording:
                try:
                    data = stream.read(CHUNK, exception_on_overflow=False)
                    frames.append(data)
                except Exception as e:
                    log("PTT read error: " + str(e))
            else:
                if frames:
                    # WAVファイルはWindows対応パスに（/tmpはWindows未対応）
                    wav_file = os.path.join(_base, "ptt_audio.wav")
                    try:
                        with wave.open(wav_file, 'wb') as wf:
                            wf.setnchannels(CHANNELS)
                            wf.setsampwidth(ptt_audio.get_sample_size(FORMAT))
                            wf.setframerate(RATE)
                            wf.writeframes(b''.join(frames))
                        with open(wav_file, 'rb') as f:
                            b64 = base64.b64encode(f.read()).decode()
                        log("PTT: wav saved (%d bytes), sending to STT" % len(b64))
                        asyncio.run_coroutine_threadsafe(
                            send_stt_request(b64), loop)
                    except Exception as e:
                        log("PTT wav/stt error: " + str(e))
                    frames = []
                time.sleep(0.05)
    except Exception as e:
        log("PTT record thread error: " + str(e))

async def send_stt_request(audio_b64):
    """RailwayのSTTプロキシにマイク音声を送信 (LINEAR16/16kHz WAV)"""
    try:
        import urllib.request
        stt_body = json.dumps({
            "audio": audio_b64,
            "encoding": "LINEAR16",
            "sampleRateHertz": 16000,
            "languageCode": ptt_lang,
        }).encode("utf-8")
        req = urllib.request.Request(
            RAILWAY_URL + "/api/stt",
            data=stt_body,
            # ⚠️2026-07-14判明：Cloudflare移行後、urllibのデフォルトUser-Agent("Python-urllib/3.x")が
            #   ボット判定されて403で弾かれるようになった（旧Railway URLはCloudflare経由じゃなかったので
            #   起きてなかった）。ブラウザ相当のUser-Agentを名乗ることで回避する。
            headers={"Content-Type": "application/json",
                     "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        text = (data.get("text") or "").strip()
        log("STT response: " + str(data))
        if text:
            broadcast({"type": "ptt_text", "text": text})
            log("PTT: recognized -> " + text)
        else:
            broadcast({"type": "ptt_text", "text": ""})
            log("PTT: STT returned empty")
    except Exception as e:
        log("STT error: " + str(e))
        broadcast({"type": "ptt_text", "text": ""})

def broadcast(event):
    # 診断ログ：ラジオ発話とPTTイベントを記録（画面と突き合わせるため）
    try:
        et = event.get('type')
        if et == 'radio':
            log("RADIO -> trigger=%s time=%s diff=%s delta=%s reason=%s (lap timing check)" %
                (event.get('trigger'), event.get('time'), event.get('diff'), event.get('delta'), event.get('reason')))
        elif et == 'ptt':
            log("PTT event -> " + str(event.get('state')))
    except Exception:
        pass
    if not connected_clients or loop is None:
        return
    msg = json.dumps(event)
    asyncio.run_coroutine_threadsafe(_broadcast_async(msg), loop)

async def _broadcast_async(msg):
    dead = set()
    for client in connected_clients.copy():
        try:
            await client.send(msg)
        except Exception:
            dead.add(client)
    connected_clients.difference_update(dead)

class IRacingReader:
    H_STATUS = 4
    H_SESSION_INFO_LEN = 16
    H_SESSION_INFO_OFFSET = 20
    H_NUM_VARS = 24
    H_VAR_HEADER_OFFSET = 28
    H_NUM_BUF = 32
    VARBUF_BASE = 48
    VARBUF_STRIDE = 16
    VAR_HEADER_SIZE = 144
    VAR_NAME_OFF = 16

    def __init__(self):
        self._handle = None
        self._ptr = None
        self.var_cache = {}

    def is_open(self):
        return self._ptr is not None

    def open(self):
        # iRacingが作った既存メモリに接続する（自分で作らない＝空マップ誤作成を防ぐ）
        if _k32 is None:
            return False
        h = _k32.OpenFileMappingW(FILE_MAP_READ, False, IRSDK_MEMMAPFILE)
        if not h:
            return False  # iRacing未起動
        ptr = _k32.MapViewOfFile(h, FILE_MAP_READ, 0, 0, 0)
        if not ptr:
            _k32.CloseHandle(h)
            return False
        self._handle = h
        self._ptr = ptr
        return True

    def close(self):
        try:
            if self._ptr:
                _k32.UnmapViewOfFile(ctypes.c_void_p(self._ptr))
            if self._handle:
                _k32.CloseHandle(self._handle)
        except Exception:
            pass
        self._ptr = None
        self._handle = None
        self.var_cache = {}

    def _bytes(self, offset, size):
        return ctypes.string_at(self._ptr + offset, size)

    def _read_int(self, off):
        return struct.unpack('i', self._bytes(off, 4))[0]

    def is_active(self):
        if not self._ptr:
            return False
        try:
            return self._read_int(self.H_STATUS) == 1
        except Exception:
            return False

    def get_buf_offset(self):
        try:
            num_buf = self._read_int(self.H_NUM_BUF)
            best_tick = -1
            best_off = 0
            for i in range(min(num_buf, 4)):
                base = self.VARBUF_BASE + i * self.VARBUF_STRIDE
                tick = self._read_int(base)
                off = self._read_int(base + 4)
                if tick > best_tick:
                    best_tick = tick
                    best_off = off
            return best_off
        except Exception:
            return 0

    def find_var(self, name):
        if name in self.var_cache:
            return self.var_cache[name]
        if not self._ptr:
            return None
        try:
            num_vars = self._read_int(self.H_NUM_VARS)
            var_hdr_off = self._read_int(self.H_VAR_HEADER_OFFSET)
            for i in range(min(num_vars, 600)):
                base = var_hdr_off + i * self.VAR_HEADER_SIZE
                vh = self._bytes(base, self.VAR_HEADER_SIZE)
                if len(vh) < self.VAR_HEADER_SIZE:
                    break
                vtype = struct.unpack_from('i', vh, 0)[0]
                voffset = struct.unpack_from('i', vh, 4)[0]
                raw_name = vh[self.VAR_NAME_OFF:self.VAR_NAME_OFF + 32]
                vname = raw_name.split(b'\x00')[0].decode('utf-8', errors='ignore')
                if vname == name:
                    result = (vtype, voffset)
                    self.var_cache[name] = result
                    return result
        except Exception:
            pass
        return None

    def read_float(self, name):
        try:
            info = self.find_var(name)
            if not info:
                return None
            return struct.unpack('f', self._bytes(self.get_buf_offset() + info[1], 4))[0]
        except Exception:
            return None

    def read_double(self, name):
        try:
            info = self.find_var(name)
            if not info:
                return None
            return struct.unpack('d', self._bytes(self.get_buf_offset() + info[1], 8))[0]
        except Exception:
            return None

    def read_int(self, name):
        try:
            info = self.find_var(name)
            if not info:
                return None
            return struct.unpack('i', self._bytes(self.get_buf_offset() + info[1], 4))[0]
        except Exception:
            return None

    def read_bool(self, name):
        try:
            info = self.find_var(name)
            if not info:
                return None
            return self._bytes(self.get_buf_offset() + info[1], 1)[0] != 0
        except Exception:
            return None

    def read_float_array(self, name, count=64):
        try:
            info = self.find_var(name)
            if not info:
                return None
            data = self._bytes(self.get_buf_offset() + info[1], 4 * count)
            return list(struct.unpack('f' * count, data))
        except Exception:
            return None

    def read_int_array(self, name, count=64):
        try:
            info = self.find_var(name)
            if not info:
                return None
            data = self._bytes(self.get_buf_offset() + info[1], 4 * count)
            return list(struct.unpack('i' * count, data))
        except Exception:
            return None

    def read_session_info(self):
        try:
            si_len = self._read_int(self.H_SESSION_INFO_LEN)
            si_offset = self._read_int(self.H_SESSION_INFO_OFFSET)
            if si_len <= 0 or si_offset <= 0:
                return None
            raw = self._bytes(si_offset, min(si_len, 200000))
            return raw.decode('utf-8', errors='ignore')
        except Exception:
            return None


def parse_session_info(yaml_str):
    result = {}
    if not yaml_str:
        return result
    try:
        # Track name
        for line in yaml_str.split('\n'):
            line = line.strip()
            if line.startswith('TrackName:'):
                result['track'] = line.split(':', 1)[1].strip()
            elif line.startswith('TrackDisplayName:'):
                result['track_display'] = line.split(':', 1)[1].strip()
            elif line.startswith('EventType:'):
                result['event_type'] = line.split(':', 1)[1].strip()

        # Parse Sessions list → {SessionNum: SessionType}
        #   EventTypeは"週末イベント全体の種別"(Race週末なら予選中でも Race)なので当てにならない。
        #   現在走ってるセッションの種別は SessionNum で Sessions リストを引く必要がある。
        sessions = {}
        cur_snum = None
        for line in yaml_str.split('\n'):
            s = line.strip()
            if s.startswith('- SessionNum:'):
                try:
                    cur_snum = int(s.split(':', 1)[1].strip())
                except:
                    cur_snum = None
            elif s.startswith('SessionType:') and cur_snum is not None:
                sessions[cur_snum] = s.split(':', 1)[1].strip()
        result['sessions'] = sessions

        # Parse drivers for iRating and SOF
        drivers = []
        in_drivers = False
        current_driver = {}
        player_car_idx = -1

        for line in yaml_str.split('\n'):
            stripped = line.strip()
            if 'Drivers:' in line and stripped.startswith('Drivers:'):
                in_drivers = True
                continue
            if in_drivers:
                if stripped.startswith('- CarIdx:'):
                    if current_driver:
                        drivers.append(current_driver)
                    current_driver = {'car_idx': int(stripped.split(':')[1].strip())}
                elif stripped.startswith('IRating:'):
                    try:
                        current_driver['irating'] = int(stripped.split(':')[1].strip())
                    except:
                        pass
                elif stripped.startswith('LicLevel:'):
                    try:
                        current_driver['lic_level'] = int(stripped.split(':')[1].strip())
                    except:
                        pass
                elif stripped.startswith('LicSubLevel:'):
                    try:
                        current_driver['lic_sublevel'] = int(stripped.split(':')[1].strip())
                    except:
                        pass
                elif stripped.startswith('UserName:'):
                    current_driver['name'] = stripped.split(':', 1)[1].strip()
                elif stripped.startswith('CarNumber:'):
                    current_driver['car_number'] = stripped.split(':', 1)[1].strip().strip('"').strip("'")
                elif stripped.startswith('IsSpectator:'):
                    try:
                        current_driver['spectator'] = int(stripped.split(':')[1].strip())
                    except:
                        pass
                elif stripped.startswith('CarClassID:'):
                    try:
                        current_driver['class_id'] = int(stripped.split(':')[1].strip())
                    except:
                        pass
                elif stripped.startswith('CarClassShortName:'):
                    current_driver['class_name'] = stripped.split(':', 1)[1].strip()
                elif stripped.startswith('CarClassRelSpeed:'):
                    try:
                        current_driver['class_rel_speed'] = int(stripped.split(':')[1].strip())
                    except:
                        pass

        if current_driver:
            drivers.append(current_driver)

        # Get player car idx（iRacingの正式名は DriverCarIdx。PlayerCarIdxもフォールバック）
        for line in yaml_str.split('\n'):
            s = line.strip()
            if s.startswith('DriverCarIdx:'):
                try:
                    player_car_idx = int(s.split(':')[1].strip())
                    break
                except:
                    pass
        if player_car_idx < 0:
            for line in yaml_str.split('\n'):
                if 'PlayerCarIdx:' in line:
                    try:
                        player_car_idx = int(line.split(':')[1].strip())
                    except:
                        pass
                    break

        # Calculate SOF (exclude spectators)
        real_drivers = [d for d in drivers if d.get('spectator', 0) == 0 and d.get('irating', 0) > 0]
        if real_drivers:
            sof = int(sum(d['irating'] for d in real_drivers) / len(real_drivers))
            result['sof'] = sof
            result['num_drivers'] = len(real_drivers)

        # Store drivers and player_car_idx for class map
        result['drivers'] = drivers
        result['player_car_idx'] = player_car_idx

        # Get player info
        player = next((d for d in drivers if d.get('car_idx') == player_car_idx), None)
        if player:
            result['player_irating'] = player.get('irating', 0)
            result['player_car_class'] = player.get('class_name', '')  # 例"GT3"。記憶のキー(コース×車種)に使う
            lic_level = player.get('lic_level', 0)
            lic_sublevel = player.get('lic_sublevel', 0)
            # Convert to SR display (e.g., B 4.50)
            lic_names = {1: 'R', 2: 'D', 3: 'C', 4: 'B', 5: 'A'}
            lic_name = lic_names.get(lic_level, '?')
            sr_value = round(lic_sublevel / 100, 2)
            result['safety_rating'] = lic_name + ' ' + str(sr_value)
            result['safety_rating_raw'] = sr_value

        # セクター構成（SplitTimeInfo > Sectors > SectorStartPct）
        sectors = []
        in_split = False
        for line in yaml_str.split('\n'):
            s = line.strip()
            if s.startswith('SplitTimeInfo:'):
                in_split = True
                continue
            if in_split:
                if s.startswith('SectorStartPct:'):
                    try:
                        sectors.append(float(s.split(':', 1)[1].strip()))
                    except:
                        pass
                # SplitTimeInfoブロックの終わり（次のトップレベルキー）で抜ける
                elif s and not s.startswith('-') and not s.startswith('Sector') and ':' in s and not line.startswith(' '):
                    in_split = False
        if sectors:
            result['sectors'] = sorted(sectors)
            result['num_sectors'] = len(sectors)

    except Exception as e:
        print('Session info parse error:', e)

    return result


def fmt_time(seconds):
    if seconds is None or seconds <= 0:
        return None
    m = int(seconds / 60)
    s = seconds % 60
    return "%d:%06.3f" % (m, s)

def fmt_radio(seconds):
    # 本物のF1無線方式：分は言わず「秒」だけ言う。ドライバーは自分が何分台かは分かっている。
    # 秒は必ず2桁ゼロ埋め：101.589(1:41.589) -> 「41.589」 / 121.567(2:01.567) -> 「01.567」 / 45.3 -> 「45.300」。
    # 【例外】00秒台（分ちょうど付近）だけは分を付ける：120.567(2:00.567) -> 「2:00.567」。
    #   ← 分を落とすと「0.567」になり“0秒5”と誤解させ危険なため、この時だけ分を残す。
    # タイムは1/1000秒（サウザンス）まで＝iRacing表示と一致。
    if seconds is None or seconds <= 0:
        return None
    m = int(seconds // 60)
    s = seconds - m * 60
    if m >= 1 and int(s) == 0:
        return "%d:%06.3f" % (m, s)   # 2:00.567（00秒台は分をつける）
    return "%06.3f" % s               # 24.567 / 01.567 / 45.300（分を落とし2桁ゼロ埋め）


reader = IRacingReader()
session_info_sent = False

def poll_iracing():
    global session_info_sent
    ir_was_connected = False
    last_lap_time = None
    session_best = None
    personal_best = None
    prev_current_lap = None
    player_car_idx = -1
    player_class_id = -1
    car_class_map = {}          # car_idx -> class_id
    sessions_map = {}           # SessionNum -> SessionType（現在のセッション種別判定用）
    car_relspeed_map = {}       # car_idx -> rel speed
    car_irating_map = {}        # car_idx -> iRating（危険ドライバー警告用）
    car_sr_map = {}             # car_idx -> Safety Rating値（例 2.34）
    car_number_map = {}         # car_idx -> ゼッケン（危険ドライバー警告での認識度向上用）
    car_class_name_map = {}     # car_idx -> クラス名（例"GTP"。マルチクラス接近警告での読み上げ用）
    ahead_armed = {}            # car_idx -> bool（前方の危険ドライバー警告・再武装フラグ）
    danger_warned = {}          # car_idx -> last warned time（前後共通クールダウン）
    danger_ever_warned = set()  # car_idx -> このセッションで既に警告済みか（同じ危険ドライバーへの連呼を根絶。ギャップ往復での再発火を防ぐため再武装方式でなく永久に1回のみ）
    player_rel_speed = 0
    is_race_session = False
    inactive_since = None
    multiclass_warned = {}      # car_idx -> last warned time (5s stage)
    multiclass_2s_warned = {}   # car_idx -> last warned time (2s stage)
    multiclass_armed = {}       # car_idx -> bool（6秒より離れたら再武装。張り付き連呼防止）
    last_mc_diag_ts = 0.0       # マルチクラス「コールゼロ」診断ログの最終出力時刻
    battle_warned = {}          # car_idx -> last warned time
    last_battle_global = 0.0    # 全車共通のバトルコール間隔（連鎖スパム防止）
    behind_armed = {}           # car_idx -> bool（一度離れて再接近した時だけ1回警告する再武装フラグ）
    battle_ever_warned = set()  # car_idx -> このセッションで一度でもbattle_behindを鳴らした相手か（2回目以降は"再接近"の言い方にする）
    prev_session_state = 0      # previous SessionState value
    race_start_time = None      # wall time when Racing state began
    rolling_gap_warned_time = 0 # last rolling-start gap call time
    last_telem_ts = 0.0         # ライブテレメトリ・スナップショットの最終送信時刻
    nearest_ahead_gap = None    # 直前の車とのギャップ（秒）
    nearest_behind_gap = None   # 直後の車とのギャップ（秒）
    car_pos_hist = {}           # car_idx -> (LapDistPct, timestamp)（停止車両検知用）
    car_stopped_since = {}      # car_idx -> 停止し始めた時刻（動いていればキー無し）
    stopped_check_ts = 0.0      # 停止判定の最終サンプリング時刻
    stopped_armed = {}          # car_idx -> bool（7秒圏外まで離れたら再武装）
    stopped_warned = {}         # car_idx -> last warned time
    catchup_stage = {}          # car_idx -> 前方車両への段階的キャッチアップコール、直近で知らせた段階(0=未・1=7秒・2=4秒・3=3秒・4=1.5秒)
    defend_stage = {}           # car_idx -> 後方車両への段階的ディフェンスコール、同上
    gap_pace_hist = {}          # car_idx -> 直前ラップでのpace_diff（トレンド判定・確度の高低に使う）
    in_corner = False           # コーナー単位サイドバイサイド検知：今コーナー中か
    corner_over_count = 0       # 舵角がCORNER_ENTRY_RADを超えた連続サンプル数
    corner_under_count = 0      # 舵角がCORNER_EXIT_RADを下回った連続サンプル数
    corner_sides_announced = set()  # 今のコーナーで既に知らせた側（'left'/'right'/'both'）。コーナー(ゾーン)が変わったらリセット
    straight_sbs_warned = 0.0   # ストレートでの3台以上並走、最終通知時刻（クールダウン用）
    side_zone_active = False    # ⑤ コーナー or 強ブレーキ中の「サイドカー通知ゾーン」に今いるか（立ち上がりで再武装）
    prev_limiter_on = False     # ⑥ 直前ループでピットリミッターが作動中だったか（ON→OFF検知用）
    limiter_off_announced_stop = False  # ⑥ 今回のピットストップで既に「リミッターオフ」を鳴らしたか（二重発火防止）
    # セッションサマリー蓄積
    session_laps = []           # [{lap, time, sectors, class_pos, incident_delta}]
    session_incidents_total = 0
    session_track = ''
    session_car_class = ''
    session_event_type = ''
    session_num_in_class = 0
    pit_enter_time = None   # ピットレーン進入時のSessionTime（所要時間実測用）
    pit_enter_pos = None    # 進入時のクラス順位（復帰順位の比較用）
    summary_sent = False        # チェッカー後に1回だけ送る
    checkered_pending = False   # チェッカー(全体状態)は見えたが、自分はまだ完走してない待機フラグ
    session_racing_started = False  # SessionState 4(Racing)を確認した後のみサマリー送信
    fuel_strategy_warned = False
    fuel_at_lap_start = None    # 直近ラップ開始時点の燃料残量（ラップ消費量算出用）
    fuel_per_lap_hist = []      # 直近ラップ毎の消費量（外れ値を均すため直近5周の平均を使う）
    pit_this_lap = False        # この周でピットを通ったか（アウト/インラップは燃料学習から除外）
    lap_time_hist = []          # 直近ラップタイム履歴（時間制セッションの残り周回推定に使う・瞬間値の異常値対策）
    fuel_strategy = None        # 直近算出した燃料戦略(dict)。telemetry_liveで毎回同送する
    session_check_counter = 0
    last_session_sig = None
    consecutive_slow = 0
    consistent_lap_count = 0   # lap_consistentを3周に1回だけ発話するためのカウンター
    lap_delta_hist = []        # 直近ラップのsession_best差分履歴（AIペース判断用の生データ、直近8周）
    debug_counter = 0
    tow_active = False         # トーイング中フラグ（開始時に1回だけ声かけ・終了でリセット）
    prev_damage_s = 0.0        # 前回計測のdamage_s（義務+任意修理秒）。増えたら1回だけダメージ報告
    prev_incidents = None
    incident_times = []
    prev_driver_state = None
    leader_lap_time_hist = []       # 1位の直近ラップタイム履歴（タイムサーティン耐久の終了予測用）
    leader_last_laptime_seen = None # 同じラップタイム値を重複して履歴に積まないための直前値
    sector_bounds = []          # 例 [0.0, 0.333, 0.667]
    cur_sector = None
    sector_entry_time = None
    lap_sector_times = []
    best_sectors = []
    prev = {
        'pos': None, 'class_pos': None, 'fuel': None, 'lap': None,
        'lapsTot': None, 'onPit': None, 'tempLap': None
    }

    while True:
        if not reader.is_open():
            if reader.open():
                log("iRacing memory map opened (attached to iRacing)")
            else:
                time.sleep(2)
                continue

        active = reader.is_active()

        if active and not ir_was_connected:
            log(">>> iRacing CONNECTED - telemetry flowing")
            session_info_sent = False
            reader.var_cache.clear()
            broadcast({'type': 'iracing_connected'})
            ir_was_connected = True
            inactive_since = None
            prev_current_lap = None   # セッション移行後の誤検知防止
            last_lap_time   = None   # 次の本当のラップを必ず報告
            # ★コース/セッションが変わったら前のベストを引きずらない。
            #   でないと前コースのベストと比較して「2周続けて遅い」等の誤爆が出る。
            session_best        = None
            personal_best       = None
            consecutive_slow    = 0
            consistent_lap_count = 0

        # 切断は15秒間ずっと非アクティブな時だけ（セッション移行・ロード中を含むブリップで初期化しない）
        if not active and ir_was_connected:
            if inactive_since is None:
                inactive_since = time.time()
            elif time.time() - inactive_since >= 15.0:
                log("<<< iRacing DISCONNECTED (sustained 5s)")
                broadcast({'type': 'iracing_disconnected'})
                ir_was_connected = False
                session_info_sent = False
                last_session_sig = None
                inactive_since = None
                # ベストタイム/セクターは保持する（週末を通して継続＝エンジニアの記憶）
                reader.close()
                time.sleep(2)
                continue
            # 5秒未満の中断：何もせず維持（記憶も接続も保つ）
            time.sleep(0.3)
            continue
        else:
            inactive_since = None

        if not active:
            time.sleep(1)
            continue

        # Send session info once per connection
        # セッション情報：初回送信＋10秒ごとに変更チェック（練習→レース移行を検知）
        session_check_counter += 1
        if not session_info_sent or session_check_counter >= 100:
            session_check_counter = 0
            yaml_str = reader.read_session_info()
            if yaml_str:
                info = parse_session_info(yaml_str)
                if info.get('player_irating'):
                    # シグネチャは「セッションを定義する安定値」のみ（SOF/人数は他車ジョインで変動するため除外）
                    sig = str(info.get('event_type', '')) + '|' + str(info.get('track', ''))
                    if info.get('sessions'):
                        sessions_map = info['sessions']   # {SessionNum: SessionType}
                    session_track = info.get('track', '')
                    session_car_class = info.get('player_car_class', '')
                    session_event_type = info.get('event_type', '')
                    session_num_in_class = info.get('num_drivers', 0)
                    session_info_sent = True
                    # ── 本当に新しいセッションの時だけ：briefing送信＋状態リセット ──
                    if sig != last_session_sig:
                        broadcast({'type': 'session_info', 'data': info})
                        log("Session info sent: " + str(info.get('event_type')) + " SOF:" + str(info.get('sof'))
                            + " class:" + str(info.get('player_car_class')) + " drivers:" + str(info.get('num_drivers'))
                            + " track:" + str(info.get('track')) + " iR:" + str(info.get('player_irating'))
                            + " SR:" + str(info.get('safety_rating')))
                        # ── 診断ログ：ゼッケンとSRの不一致調査（2026-07-14 Yuji IMSA実走）──────────
                        # #28のログSR2.23 vs 結果画面SR1.51の食い違いを次回切り分けるため、iRacingの
                        # DriverInfoが「セッション開始時点で」各車に何を報告しているかをそのまま吐く。
                        # ここの値=結果画面の最終値なら我々の紐付けバグ、違えば開始時スナップショット問題。
                        for _dd in info.get('drivers', []):
                            if _dd.get('spectator', 0) == 0 and _dd.get('irating', 0) > 0:
                                _srv = round(_dd.get('lic_sublevel', 0) / 100, 2)
                                log("  DRIVER idx=" + str(_dd.get('car_idx')) + " #" + str(_dd.get('car_number', '?'))
                                    + " '" + str(_dd.get('name', '?')) + "' LIC=" + str(_dd.get('lic_level', '?'))
                                    + "." + str(_dd.get('lic_sublevel', '?')) + "(SR " + str(_srv) + ")"
                                    + " iR=" + str(_dd.get('irating', '?')) + " class=" + str(_dd.get('class_name', '?')))
                        last_session_sig = sig
                        summary_sent = False            # サマリーリセット
                        checkered_pending = False       # チェッカー待機フラグもリセット
                        session_racing_started = False  # 走行開始フラグもリセット
                        session_laps = []               # 前セッションのラップ記録クリア
                if 'drivers' in info:
                    for d in info.get('drivers', []):
                        if 'car_idx' in d and 'class_id' in d:
                            car_class_map[d['car_idx']] = d['class_id']
                        if 'car_idx' in d and 'class_name' in d:
                            car_class_name_map[d['car_idx']] = d['class_name']
                        if 'car_idx' in d and 'car_number' in d:
                            car_number_map[d['car_idx']] = d['car_number']
                        if 'car_idx' in d and 'class_rel_speed' in d:
                            car_relspeed_map[d['car_idx']] = d['class_rel_speed']
                        if 'car_idx' in d and 'irating' in d:
                            car_irating_map[d['car_idx']] = d['irating']
                        if 'car_idx' in d and 'lic_level' in d:
                            # LicSubLevelは100倍値（例234→2.34）。無ければ中間値扱いで警告しない。
                            sub = d.get('lic_sublevel', 300)
                            car_sr_map[d['car_idx']] = round(sub / 100, 2)
                player_car_idx = info.get('player_car_idx', -1)
                player_class_id = car_class_map.get(player_car_idx, -1)
                player_rel_speed = car_relspeed_map.get(player_car_idx, 0)
                if info.get('sectors'):
                    sector_bounds = info['sectors']
                    best_sectors = [None] * len(sector_bounds)
                    log("Track sectors detected: " + str(len(sector_bounds)))

        pos         = reader.read_int('PlayerCarPosition')
        lapTime     = reader.read_float('LapLastLapTime')
        currentLap  = reader.read_float('LapCurrentLapTime')
        fuel        = reader.read_float('FuelLevel')
        lap         = reader.read_int('Lap')
        lapsTot     = reader.read_int('SessionLapsTotal')
        timeRemain  = reader.read_float('SessionTimeRemain')  # 時間制セッション用(秒)。周回制では巨大値/無関係
        onPit       = reader.read_bool('OnPitRoad')
        onTrack     = reader.read_bool('IsOnTrack')
        incidents   = reader.read_int('PlayerCarMyIncidentCount')
        if onPit:
            pit_this_lap = True   # この周でピットを通った→燃料学習から除外（アウト/インラップ）
        cur_ss      = reader.read_int('SessionState') or 0
        class_pos   = reader.read_int('PlayerCarClassPosition') or pos

        # 現在のセッションが「レース」か毎ループ判定（予選/練習でレース用アラートを出さない）。
        # EventTypeでなく SessionNum→SessionType で現在走行中のセッション種別を引く。
        cur_snum        = reader.read_int('SessionNum')
        cur_sess_type   = sessions_map.get(cur_snum, '') if cur_snum is not None else ''
        is_race_session = ('race' in cur_sess_type.lower())

        # SessionState: 3=ParadeLaps(formation/rolling), 4=Racing
        if cur_ss == 4 and prev_session_state != 4:
            race_start_time = time.time()
        if cur_ss >= 2:  # Warmup以上 = 何らかのセッションで走行中
            if onTrack:
                session_racing_started = True
        prev_session_state = cur_ss
        in_formation  = (cur_ss == 3)   # ローリング中 = ギャップコール停止
        # スタート直後の密集でバトルコールが暴発するのを抑制。
        # 30秒＋「1周目まるごと」＝ロングコース(ニュル等・1周7-8分)でも密集が解けるまで黙る。
        in_start_rush = (cur_ss == 4 and (
                            (race_start_time is not None and time.time() - race_start_time < 30)
                            or (lap is not None and lap <= 1)))

        # ── ドライバーの現在地（走行中/ピット/ガレージ）──
        if onPit:
            driver_state = 'pit'
        elif onTrack:
            driver_state = 'track'
        else:
            driver_state = 'garage'
        if driver_state != prev_driver_state:
            broadcast({'type': 'driver_state', 'state': driver_state})
            # ガレージから復帰＝新しいスティント開始（耐久レースのドライバー交代・給油の可能性が高い）。
            #   古いスティントの燃料消費履歴（fuel_per_lap_hist）を持ち越すと、交代直後に「あと何周」を
            #   聞かれた時、前任ドライバーの消費率×今のスティントの残燃料で計算してしまい数字が破綻する
            #   （2026-07-11の耐久レースログで実際に発生：交代直後に燃料0/聞き返しが起きた）。
            #   ここでリセットすれば、以後はこのスティントの実測だけで再計算が始まる
            #   （clean_laps_sampledが2-3周の時点でも平均は出るので、5周貯まるのを待たず答えられる）。
            if prev_driver_state == 'garage' and driver_state in ('track', 'pit'):
                fuel_at_lap_start = None
                fuel_per_lap_hist = []
                fuel_strategy = None
                log('new stint detected (garage -> ' + driver_state + ') — fuel history reset')
            # ガレージ戻り＝セッション終了 → Practice/Qualifyでも1回サマリー送信
            if driver_state == 'garage' and not summary_sent and session_laps and session_racing_started:
                times = [r['time'] for r in session_laps if r['time'] > 0]
                if times:
                    best_t = min(times)
                    avg_fuel_summary = round(sum(fuel_per_lap_hist)/len(fuel_per_lap_hist), 2) if fuel_per_lap_hist else None
                    broadcast({
                        'type': 'session_summary',
                        'track': session_track,
                        'car_class': session_car_class,   # 記憶キー(コース×車種)用
                        'event_type': session_event_type,
                        'is_race': is_race_session,        # クライアント側でデブリーフ自動誘導を出すかの判定に使う
                        'total_laps': len(session_laps),
                        'finish_pos': class_pos,
                        'best_lap': round(best_t, 3),
                        'worst_lap': round(max(times), 3),
                        'avg_lap': round(sum(times)/len(times), 3),
                        'avg_fuel_per_lap': avg_fuel_summary,  # 平均燃料消費(L/周)。1階記憶に保存
                        'incidents': prev_incidents or 0,
                        'laps': session_laps,
                    })
                    log('Session summary sent: ' + str(len(session_laps)) + ' laps, best ' + str(round(best_t, 3)))
                    summary_sent = True
                    checkered_pending = False
            log('driver state -> ' + driver_state)
            prev_driver_state = driver_state

        lfTemp      = reader.read_float('LFtempCM')
        rfTemp      = reader.read_float('RFtempCM')
        lrTemp      = reader.read_float('LRtempCM')
        rrTemp      = reader.read_float('RRtempCM')

        # ── 気象データ（八木さん実走で「路面温度データ来てない」が判明→追加） ──
        # iRacing SDKは摂氏で返す。ドライバーは華氏派も多いが、まず数字を渡してAI側でどちら派にも対応。
        # None判定はvalue is not None で厳密に（0℃も有効値なので truthy判定はダメ）。
        track_temp_c = reader.read_float('TrackTempCrew')   # 路面温度（クルーが報告する路面表面温度・耐久で刻々変わる主要変数）
        if track_temp_c is None:
            track_temp_c = reader.read_float('TrackTemp')   # フォールバック（TrackTempCrewが無い/Noneのセッション用）
        air_temp_c   = reader.read_float('AirTemp')         # 気温
        rel_humidity = reader.read_float('RelativeHumidity') # 湿度 0..1
        track_wet    = reader.read_float('TrackWetness')     # 路面ウェット度 0..1(乾) - iRacing 2024+
        weather = {
            'track_temp_c': round(track_temp_c, 1) if track_temp_c is not None else None,
            'air_temp_c':   round(air_temp_c, 1)   if air_temp_c is not None   else None,
            'humidity':     round(rel_humidity * 100, 0) if rel_humidity is not None else None,
            'track_wetness': round(track_wet, 2) if track_wet is not None else None,
        }

        # ── コーナー単位サイドバイサイド検知（新規・2026-07-14 Yuji設計）──
        # 舵角(SteeringWheelAngle)でコーナー進入/脱出を検知し、その間だけiRacing公式スポッター値
        # (CarLeftRight)を見て「隣に車がいるか」を判定する。左右の物理位置はiRacing自身が計算済みの
        # 値をそのまま使う(自前で推定する必要なし・CarLeftRight: 0=off 1=clear 2=左 3=右 4=両側 5=左2台 6=右2台)。
        # ヒステリシスで閾値ギリギリのふらつきによる誤検知/連続発火を防ぐ(3サンプル連続で判定)。
        steering_angle = reader.read_float('SteeringWheelAngle')
        car_left_right = reader.read_int('CarLeftRight')
        brake_val = reader.read_float('Brake')
        if steering_angle is not None and is_race_session and not in_start_rush:
            _sa = abs(steering_angle)
            if _sa > CORNER_ENTRY_RAD:
                corner_over_count += 1
                corner_under_count = 0
            elif _sa < CORNER_EXIT_RAD:
                corner_under_count += 1
                corner_over_count = 0
            else:
                corner_over_count = 0
                corner_under_count = 0

            # ⑤ ラグ対策：進入は即(1サンプル)で確定する。追い抜きはコーナー手前から始まり、以前は
            # 「舵角が3サンプル(0.3秒)乗るまで待つ」せいで相手が1/4前に出てからのコールになっていた。
            # 脱出はヒステリシスで3サンプル継続（コーナー中の一瞬の戻し舵での誤脱出を防ぐ）。
            if not in_corner and corner_over_count >= 1:
                in_corner = True
                corner_over_count = 0
            elif in_corner and corner_under_count >= 3:
                in_corner = False
                corner_under_count = 0

            # ⑤ 「サイドカー通知ゾーン」＝コーナー中 or 強めのブレーキ中。追い抜きはブレーキング勝負で
            # 始まり、舵角が乗る前にCarLeftRight(公式スポッター)は既に隣を検知している。舵角ロックを
            # 待たずブレーキ検知で前倒しすることで「相手が並ぶ前」にコールする。ゾーン立ち上がりで再武装。
            braking = brake_val is not None and brake_val > 0.35
            in_side_zone = in_corner or braking
            if in_side_zone and not side_zone_active:
                side_zone_active = True
                corner_sides_announced = set()  # 新しいゾーン＝再武装
            elif not in_side_zone and side_zone_active:
                side_zone_active = False

            _now3 = time.time()
            if in_side_zone and car_left_right is not None and car_left_right >= 2:
                _side = {2: 'left', 5: 'left', 3: 'right', 6: 'right', 4: 'both'}.get(car_left_right)
                if _side and _side not in corner_sides_announced:
                    corner_sides_announced.add(_side)
                    if _now3 - last_battle_global > 8:  # サイドコールは安全直結＝短めのクールダウン。側ごとにdedup済み。
                        _side_msg = {'left': 'Car left.', 'right': 'Car right.', 'both': 'Cars both sides.'}[_side]
                        broadcast({'type': 'radio', 'trigger': 'side_by_side', 'side': _side, 'message': _side_msg})
                        last_battle_global = _now3
            # ストレート(ゾーン外)で3台以上並走の検知。CarLeftRight=4(両側)/5/6(片側2台)を代用
            # (自分+両側1台ずつ、または自分+片側2台＝どちらも計3台)。2台までは自分で見えるのでスルー。
            elif not in_side_zone and car_left_right in (4, 5, 6):
                if _now3 - straight_sbs_warned > 20 and _now3 - last_battle_global > 15:
                    broadcast({'type': 'radio', 'trigger': 'multi_car_straight', 'message': 'Three wide. Watch the space.'})
                    straight_sbs_warned = _now3
                    last_battle_global = _now3

        # ── タイヤ詳細（4輪×内中外温度＋摩耗）と損傷代理(修理所要秒) ──
        # 項目7：「右フロント垂れてる」「損傷は？」に実データで答えるため。聞かれた時だけ使う。
        def _tire(corner):
            # 温度[内,中,外]と摩耗残%[内,中,外]。%は0-1で来るので100倍。
            t = [reader.read_float(corner+'tempCL'), reader.read_float(corner+'tempCM'), reader.read_float(corner+'tempCR')]
            w = [reader.read_float(corner+'wearL'), reader.read_float(corner+'wearM'), reader.read_float(corner+'wearR')]
            t = [round(x,1) if x is not None else None for x in t]
            w = [round(x*100,1) if x is not None else None for x in w]
            return {'t': t, 'w': w}
        tires = {'lf': _tire('LF'), 'rf': _tire('RF'), 'lr': _tire('LR'), 'rr': _tire('RR')}
        repair_mand = reader.read_float('PitRepairLeft')      # 義務修理の残り秒（>0=要修理の損傷あり）
        repair_opt  = reader.read_float('PitOptRepairLeft')   # 任意修理の残り秒
        damage_s = round((repair_mand or 0) + (repair_opt or 0), 1)

        # ── 1位のペース追跡（タイムサーティン耐久レースの終了予測用・2026-07-12 Yujiと設計合意） ──
        # 時間制レース（3時間耐久等）は、1位が残り時間内にあと何周走ってチェッカーを受けるかで
        # 初めて最終周回数が決まる。自分がピット中で戦略判断している時こそ知りたい数字なので、
        # 自分のonTrack状態に関係なく毎周期更新する（下のfuel_strategy計算で使う）。
        car_positions = reader.read_int_array('CarIdxPosition', 64)
        car_laps_all  = reader.read_int_array('CarIdxLap', 64)
        leader_idx = None
        if car_positions:
            for _pidx, _ppos in enumerate(car_positions):
                if _ppos == 1:
                    leader_idx = _pidx
                    break
        leader_lap = None
        if leader_idx is not None and car_laps_all and leader_idx < len(car_laps_all):
            leader_lap = car_laps_all[leader_idx]
        if leader_idx is not None:
            _leader_llt = reader.read_float_array('CarIdxLastLapTime', 64)
            if _leader_llt and leader_idx < len(_leader_llt):
                _llt = _leader_llt[leader_idx]
                # 20〜600秒の妥当範囲のみ・同じ値の重複積み上げ防止（他の履歴と同じ異常値対策）
                if _llt and 20 < _llt < 600 and _llt != leader_last_laptime_seen:
                    leader_lap_time_hist.append(_llt)
                    if len(leader_lap_time_hist) > 5:
                        leader_lap_time_hist.pop(0)
                    leader_last_laptime_seen = _llt

        # ── 診断ログ：データが実際に読めているか5秒ごとに表示 ──
        debug_counter += 1
        if debug_counter >= 50:
            debug_counter = 0
            spd = reader.read_float('Speed')
            # ★2026-07-12追加（耐久データログ）：OnTrack:Falseのまま実は走行中だった謎の固着
            #   （八木さんの耐久ログで発覚・約56分間Speed/Pos/LapTimeは動いてるのにOnTrack/Lapだけ
            #   固着）を次回再現時に切り分けられるよう、生のOnPit/SessionState/driver_state/燃料も出す。
            log("DATA CHECK -> Lap:" + str(lap) + " Pos:" + str(pos) +
                " LastLap:" + str(lapTime) + " Speed:" + str(round(spd,1) if spd else None) +
                " OnTrack:" + str(onTrack) + " OnPit:" + str(onPit) +
                " SessState:" + str(cur_ss) + " DriverState:" + str(driver_state) +
                " Fuel:" + str(round(fuel,1) if fuel is not None else None) +
                " CarIdx:" + str(player_car_idx) +   # 担当車の把握確認用
                " gapAhead:" + str(nearest_ahead_gap) + " gapBehind:" + str(nearest_behind_gap) +
                " TrackT:" + str(track_temp_c) + " AirT:" + str(air_temp_c))   # 天候読み取り確認用


        # ── ラップ完了検知：LapLastLapTime の「値が変わった瞬間」で発火 ──
        # 【重要】Lapカウンター増加で発火すると、iRacingのLapLastLapTime更新が
        #   1tick遅れるため「1周前のタイムを1周遅れて」報告する旧バグが出る。
        #   LapLastLapTime が新しい有効値に変わった瞬間なら、それが今完了したラップ＝ズレも遅延もゼロ。
        lap_time_changed = (
            lapTime is not None and lapTime > 0 and
            (last_lap_time is None or abs(lapTime - last_lap_time) > 0.001)
        )
        prev_current_lap = currentLap  # 互換性のため残す（使用しない）

        # ── セクター計測（走行中は黙る・ラップ完了時にデータのみ送信）──
        if sector_bounds and onTrack:
            try:
                dist = reader.read_float('LapDistPct')
                stime = reader.read_double('SessionTime')
                if dist is not None and stime is not None and dist >= 0:
                    # 現在のセクター番号（dist以下で最大の境界のindex）
                    idx = 0
                    for i, b in enumerate(sector_bounds):
                        if dist >= b:
                            idx = i
                    if cur_sector is None:
                        cur_sector = idx
                        sector_entry_time = stime
                    elif idx != cur_sector:
                        st = stime - sector_entry_time if sector_entry_time is not None else 0
                        if 0 < st < 600:
                            while len(lap_sector_times) <= cur_sector:
                                lap_sector_times.append(None)
                            lap_sector_times[cur_sector] = st
                        sector_entry_time = stime
                        # スタート地点に戻った（idx < cur_sector）= ラップ完了 → データ送信
                        if idx < cur_sector and lap_sector_times:
                            secs = []
                            for i, t_ in enumerate(lap_sector_times):
                                if t_ is None:
                                    continue
                                pb = best_sectors[i] if i < len(best_sectors) else None
                                delta = round(t_ - pb, 2) if pb else 0.0
                                is_best = (pb is None or t_ < pb)
                                if is_best and i < len(best_sectors):
                                    best_sectors[i] = t_
                                secs.append({'sector': i + 1, 'time': round(t_, 2),
                                             'delta': delta, 'best': is_best})
                            if secs:
                                broadcast({'type': 'lap_sectors', 'sectors': secs})
                            lap_sector_times = []
                        cur_sector = idx
            except Exception:
                pass

        # ── ラップタイム処理（LapLastLapTimeの値変化＝ライン通過直後に即発火）──
        # スタートライン通過で上がったタイムは、コースに関係なく即座にそのまま読み上げる。
        # （最初の1本もアウトラップ扱いで握りつぶさない。1周目はfirst_lap=Baselineとしてコール）
        # ※onTrack必須：ガレージ/グリッド/牽引中(OnTrack:False)のゴミラップ値を弾く。
        # ── 燃料to-フィニッシュ戦略計算（ラップ完了ごとに更新）──
        # 直近5周の平均消費量から、残り周回を走り切れるかを算出。数値は捏造せずここで計算した
        # 実測値のみをClaudeへ渡す(prompts.jsのliveNote経由)。
        if lap_time_changed and onTrack and fuel is not None:
            if fuel_at_lap_start is not None:
                used = fuel_at_lap_start - fuel
                # アウト/インラップ(ピット通過周)はピットレーン低速でクリーンラップより消費が
                # 少なく、平均を過小評価する(2026/7/7実走で2.5L誤表示・実3.8Lの主因)。除外する。
                if 0 < used < 20 and not pit_this_lap:
                    fuel_per_lap_hist.append(used)
                    if len(fuel_per_lap_hist) > 5:
                        fuel_per_lap_hist.pop(0)
            fuel_at_lap_start = fuel
            pit_this_lap = False  # 次の周の判定用にリセット

            # ⚠️2026/7/5判明バグ：ラップ切り替わり直後の瞬間的なlapTime単発値をそのまま使うと、
            # 稀に異常に小さい値を拾って「20分で78周」のような物理的にありえない残り周回数を
            # 算出してしまう(Yuji実走IMSAテストで発覚・致命的)。妥当な範囲(20秒〜600秒)のラップ
            # タイムだけ履歴に積み、直近3周の平均を使うことで単発の異常値に引きずられなくする。
            if lapTime and 20 < lapTime < 600:
                lap_time_hist.append(lapTime)
                if len(lap_time_hist) > 5:
                    lap_time_hist.pop(0)

            if fuel_per_lap_hist:
                avg_fuel_lap = sum(fuel_per_lap_hist) / len(fuel_per_lap_hist)
                # ── ①消費量は「クリーンラップ1本でも」即Lunaへ送る（短いレース対応・2-4周で読めるように）──
                # レース長(残り周回)が分からなくても、燃料残量÷消費量で「あと何周走れるか」は出せる。
                # これを常に持たせることで、練習/テストドライブや序盤でも燃料を把握できる（捏造防止）。
                laps_of_fuel_left = round(fuel / avg_fuel_lap, 1) if avg_fuel_lap > 0 else None
                fuel_strategy = {
                    'avg_fuel_per_lap': round(avg_fuel_lap, 2),
                    'laps_of_fuel_left': laps_of_fuel_left,   # 現燃料であと何周走れるか（レース長不要）
                    'clean_laps_sampled': len(fuel_per_lap_hist),  # 何周分の実測から出したか（信頼度の目安）
                }
                # ── ②レース長が分かる時だけ、to-フィニッシュの余裕/不足も足す ──
                # 周回制はシンプル（総周回-現在周回）。時間制（タイムサーティン）は1位のペースで
                # 最終ラップ番号を予測し、自分が同一周回（lead lap）ならそれに準ずる。ラップダウン
                # している場合は1位のフィニッシュと自分の周回数が一致しないので、自分のペース×
                # 残り時間で計算する（2026-07-12 Yujiと設計合意・詳細はコメント末尾）。
                laps_remaining_est = None
                finish_basis = None   # プロンプト側で「1位基準」「ラップダウン中」等を言い分けるため
                laps_down = None
                if lapsTot and 0 < lapsTot < 3000:
                    laps_remaining_est = max(0, lapsTot - lap)
                    finish_basis = 'laps_total'
                elif timeRemain and 0 < timeRemain < 100000:
                    if leader_lap is not None and len(leader_lap_time_hist) >= 2:
                        leader_avg_lap = sum(leader_lap_time_hist) / len(leader_lap_time_hist)
                        leader_laps_left = math.ceil(timeRemain / leader_avg_lap)
                        predicted_leader_final_lap = leader_lap + leader_laps_left
                        laps_down = max(0, leader_lap - lap)  # 0=同一周回、正=ラップダウン周回数
                        if laps_down == 0:
                            laps_remaining_est = max(0, predicted_leader_final_lap - lap)
                            finish_basis = 'leader_pace'
                        elif lap_time_hist:
                            avg_lap_time = sum(lap_time_hist[-3:]) / len(lap_time_hist[-3:])
                            laps_remaining_est = math.ceil(timeRemain / avg_lap_time)
                            finish_basis = 'own_pace_lapped'
                    elif lap_time_hist:
                        # 1位のデータがまだ不十分（レース序盤・1位不明等）→ 自分のペースだけで暫定計算
                        avg_lap_time = sum(lap_time_hist[-3:]) / len(lap_time_hist[-3:])
                        laps_remaining_est = math.ceil(timeRemain / avg_lap_time)
                        finish_basis = 'own_pace_no_leader_data'

                if laps_remaining_est is not None and avg_fuel_lap > 0:
                    fuel_needed = avg_fuel_lap * (laps_remaining_est + 1)  # +1周分の安全マージン込み
                    margin_laps = round((fuel - fuel_needed) / avg_fuel_lap, 1)
                    fuel_strategy['laps_remaining_est'] = laps_remaining_est
                    fuel_strategy['finish_basis'] = finish_basis
                    if laps_down is not None:
                        fuel_strategy['laps_down'] = laps_down
                    fuel_strategy['fuel_needed'] = round(fuel_needed, 1)
                    fuel_strategy['margin_laps'] = margin_laps
                    fuel_strategy['pit_required'] = margin_laps < 0
                    # ★2026-07-12実走で発覚：ラップ完了(=このブロック発火)がピットロード進入直後に
                    #   重なると、「ピット必須だ」という警告が実際にピットロードを走行中に届いてしまう
                    #   （既にピットに向かっているのに今更「ピットしろ」と言う矛盾した無線になる）。
                    #   onPit中は新規の警告を出さない。ピットを出て、まだ margin が負のままなら
                    #   次のラップ完了時に正しく再警告される。
                    if margin_laps < 0 and not fuel_strategy_warned and not onPit:
                        broadcast({'type': 'radio', 'trigger': 'fuel_strategy_warning',
                            'margin_laps': margin_laps,
                            'message': 'Fuel will not last to the finish at this pace. Pit required.'})
                        fuel_strategy_warned = True
                    elif margin_laps >= 0:
                        fuel_strategy_warned = False  # ピット等で給油後、再度不足すれば再警告できるようリセット

        if lap_time_changed and onTrack:
            t = fmt_radio(lapTime)
            if t:
                is_session_best = (session_best is None or lapTime < session_best)
                is_personal_best = (personal_best is None or lapTime < personal_best)

                if is_personal_best:
                    if personal_best is not None:
                        diff = personal_best - lapTime
                        broadcast({'type': 'radio', 'trigger': 'personal_best', 'time': t, 'diff': round(diff, 2),
                            'message': 'Personal best. ' + t + '. Plus ' + str(round(diff, 3)) + '.'})
                    else:
                        broadcast({'type': 'radio', 'trigger': 'first_lap', 'time': t,
                            'message': t + '. Baseline lap.'})
                    personal_best = lapTime
                    session_best = lapTime

                elif is_session_best:
                    diff = lapTime - (personal_best or lapTime)
                    broadcast({'type': 'radio', 'trigger': 'session_best', 'time': t, 'diff': round(diff, 2),
                        'message': 'Session best. ' + t + '.'})
                    session_best = lapTime

                else:
                    diff = lapTime - session_best
                    # ── ペース推移の生データ蓄積（AI文脈判断用・直近8周）──
                    lap_delta_hist.append(round(diff, 2))
                    if len(lap_delta_hist) > 8:
                        lap_delta_hist.pop(0)

                    # ── ペース向上パターン（2026/7/5追加・Yuji発案）──
                    # 直近3周平均 vs その前3周平均で、はっきり速くなってる時だけ声をかける対象にする
                    # （1周だけの偶然でなく、本当に上げてきてるかを均して判定）。
                    # ここも固定の褒め言葉でなく、文脈込みでClaudeに「褒める価値があるか」判断させる。
                    if len(lap_delta_hist) >= 6:
                        recent3 = sum(lap_delta_hist[-3:]) / 3
                        prev3 = sum(lap_delta_hist[-6:-3]) / 3
                        if prev3 - recent3 >= 0.3:  # 3周平均で0.3秒以上速くなってる＝本物の向上傾向
                            broadcast({'type': 'pace_check', 'direction': 'improving',
                                'recent_deltas': lap_delta_hist[:],
                                'pos': pos, 'class_pos': class_pos,
                                'gap_ahead': round(nearest_ahead_gap, 2) if nearest_ahead_gap is not None else None,
                                'gap_behind': round(nearest_behind_gap, 2) if nearest_behind_gap is not None else None,
                                'fuel_strategy': fuel_strategy,
                            })

                    if diff < 0.3:
                        consecutive_slow = 0
                        consistent_lap_count += 1
                        if consistent_lap_count >= 3:  # 3周連続安定してから1回だけ
                            broadcast({'type': 'radio', 'trigger': 'lap_consistent', 'time': t,
                                'message': t + '. Consistent.'})
                            consistent_lap_count = 0
                    elif diff < 1.0:
                        broadcast({'type': 'radio', 'trigger': 'lap_time', 'time': t, 'diff': round(diff, 2),
                            'message': t + '. ' + str(round(diff, 1)) + ' off.'})
                    else:
                        consecutive_slow += 1
                        if consecutive_slow >= 2:
                            # ⚠️2026/7/5改修：固定ルール("2周連続スロー")で即座に定型文を喋らせるのは
                            # 「一般的なエンジニア」止まり(文脈無視)。ここでは判断そのものをClaudeに渡し、
                            # タイヤ劣化か単なる誤差/トラフィックか文脈込みで判断させる(pace_check)。
                            # 喋る価値なしとClaudeが判断したら無音のまま(renderer側でNO_CALL処理)。
                            broadcast({'type': 'pace_check', 'direction': 'degrading',
                                'recent_deltas': lap_delta_hist[:],
                                'pos': pos, 'class_pos': class_pos,
                                'gap_ahead': round(nearest_ahead_gap, 2) if nearest_ahead_gap is not None else None,
                                'gap_behind': round(nearest_behind_gap, 2) if nearest_behind_gap is not None else None,
                                'fuel_strategy': fuel_strategy,
                            })
                            consecutive_slow = 0
                        else:
                            broadcast({'type': 'radio', 'trigger': 'lap_slow', 'time': t,
                                'message': t + '. Pace down. Status?'})

                last_lap_time = lapTime
                # ── セッションサマリー用にラップデータを積算 ──
                lap_record = {
                    'lap': lap,
                    'time': round(lapTime, 3),
                    'class_pos': class_pos,
                    'pb': is_personal_best,
                }
                if lap_sector_times:
                    lap_record['sectors'] = [round(s, 2) for s in lap_sector_times]
                session_laps.append(lap_record)

                # ── チェッカー後、自分がこのラップ(S/Fライン通過)を終えた＝本当の完走タイミング ──
                # checkered_pendingは上で「セッション全体がチェッカーになった」時に立てたフラグ。
                # ここは自分のLapLastLapTimeが更新された瞬間＝自分が実際にS/Fラインを通過した瞬間なので、
                # リーダー基準でなく自分基準の完走判定になる。
                if checkered_pending and not summary_sent and session_laps and session_racing_started:
                    times = [r['time'] for r in session_laps if r['time'] > 0]
                    best_t = min(times) if times else 0
                    worst_t = max(times) if times else 0
                    avg_t = round(sum(times) / len(times), 3) if times else 0
                    half = max(1, len(times) // 2)
                    pace_first = round(sum(times[:half]) / half, 3) if times else 0
                    pace_last  = round(sum(times[half:]) / max(1, len(times) - half), 3) if times else 0
                    broadcast({
                        'type': 'session_summary',
                        'track': session_track,
                        'event_type': session_event_type,
                        'is_race': True,
                        'total_laps': len(session_laps),
                        'finish_pos': class_pos,
                        'best_lap': round(best_t, 3),
                        'worst_lap': round(worst_t, 3),
                        'avg_lap': avg_t,
                        'pace_first_half': pace_first,
                        'pace_last_half': pace_last,
                        'incidents': prev_incidents or 0,
                        'laps': session_laps,
                    })
                    log('Session summary sent (post-checkered, own lap complete): ' + str(len(session_laps)) + ' laps, best ' + str(best_t))
                    summary_sent = True
                    checkered_pending = False

        # ── ローリングスタート中：前走車ギャップが7秒超なら5秒ごとにコール ──
        if in_formation and player_car_idx >= 0:
            car_est_times_roll = reader.read_float_array('CarIdxEstTime', 64)
            if car_est_times_roll and player_car_idx < len(car_est_times_roll):
                player_t = car_est_times_roll[player_car_idx]
                best_ahead = None  # 同クラスで最も近い前方車のギャップ
                for idx2, et2 in enumerate(car_est_times_roll):
                    if idx2 == player_car_idx or et2 <= 0:
                        continue
                    if car_class_map.get(idx2, -1) != player_class_id:
                        continue
                    d2 = et2 - player_t  # 前方はマイナス(est_timeが小さい)
                    if -30 < d2 < 0:    # 前方30秒以内
                        gap = abs(d2)
                        if best_ahead is None or gap < best_ahead:
                            best_ahead = gap
                now_r = time.time()
                if (best_ahead is not None and best_ahead > 7.0 and
                        now_r - rolling_gap_warned_time > 5.0):
                    broadcast({'type': 'radio', 'trigger': 'rolling_gap',
                        'gap': round(best_ahead, 1),
                        'message': 'Gap ' + str(round(best_ahead, 1)) + '. Close up.'})
                    rolling_gap_warned_time = now_r

        # ── インシデント検知（コースオフ/接触/クラッシュ） ──────────────
        if incidents is not None:
            if prev_incidents is not None and incidents > prev_incidents:
                delta = incidents - prev_incidents
                now = time.time()
                incident_times = [t for t in incident_times if now - t < 90]
                incident_times.append(now)
                recent = len(incident_times)
                if recent >= 3:
                    msg = random.choice([
                        'Too many incidents. Calm down. Forget position — just finish.',
                        'That is enough. Reset your head. Clean laps to the flag.',
                        'Stop the risks now. Bring this car home in one piece.'])
                    broadcast({'type': 'radio', 'trigger': 'incident', 'delta': delta, 'recent': recent,
                        'message': msg})
                elif delta >= 4:
                    # 大クラッシュ＝まず身体を気遣う「Are you OK?」を最優先で。ダイレクトドライブの
                    # 強力なモーターはクラッシュ時にハンドルを持っていき、手首の捻挫/怪我が実際に起きる。
                    # 順位やレース運びより先に、ドライバーの安否を確認するのが本物のエンジニア(Yuji方針)。
                    broadcast({'type': 'radio', 'trigger': 'crash_check', 'delta': delta, 'recent': recent,
                        'message': 'Are you okay? Any injury to your hands? Can the car still drive? If not, take the tow back and we will regroup from there.'})
                elif delta >= 2:
                    msg = random.choice([
                        'Watch it. Bring it back.',
                        'Spin. Collect yourself. We are okay.',
                        'Easy. Settle it down.'])
                    broadcast({'type': 'radio', 'trigger': 'incident', 'delta': delta, 'recent': recent,
                        'message': msg})
                # delta==1（コースオフ）は基本黙る。連発時のみ上のrecent>=3で拾う
            prev_incidents = incidents

        # ── トーイング検知（走行不能でiRacingが牽引→ピットワープ）──
        # PlayerCarTowTime>0＝牽引中。事故地点からタイム積算＋ペナルティで、時間経過まで
        # ピット作業も始まらないiRacite独自ルール。牽引が始まったら1回だけ「焦らず待とう」と声かけ。
        tow_time = reader.read_float('PlayerCarTowTime')
        if tow_time is not None and tow_time > 0:
            if not tow_active:
                tow_active = True
                broadcast({'type': 'radio', 'trigger': 'towing', 'tow_time': round(tow_time, 1),
                    'message': 'Being towed back. Time counts against us until it clears, no pit work yet. Nothing you can do — breathe, we regroup when you are in.'})
        else:
            tow_active = False

        # ── ダメージレポート（2026-07-12マーボー要望：損傷度合い・走行継続可否を知りたい）──
        # crash_checkは「大丈夫か・車は動くか」という安否確認の問いかけであって実データではない。
        # ここではdamage_s(=PitRepairLeft+PitOptRepairLeft、義務+任意修理の残り秒)の増分を見て、
        # 実際に損傷が発生した時だけ1回報告する。義務修理あり=要ピットの本物の損傷、
        # 義務修理なしで任意修理のみ=見た目だけの軽微な損傷、と区別して伝える。
        # ※IRSDKに「どのパーツが脱落したか」を示す変数は無いため、部品単位の特定はできない
        #   （修理所要秒からの重大度推定のみ）。
        if damage_s > prev_damage_s + 0.5:
            mandatory = (repair_mand or 0) > 0
            if mandatory:
                dmg_msg = ('Damage confirmed — mandatory repair, about ' +
                    str(round(repair_mand)) + ' seconds. Box next lap.')
            else:
                dmg_msg = 'Cosmetic damage only. Car is still solid, keep pushing.'
            broadcast({'type': 'radio', 'trigger': 'damage_report', 'mandatory': mandatory,
                'repair_mand': round(repair_mand or 0, 1), 'repair_opt': round(repair_opt or 0, 1),
                'message': dmg_msg})
        prev_damage_s = damage_s

        # Position change（クラス内順位ベース。レースセッション＆コース走行中のみ。
        #   グリッド整列中(OnTrack:False)は順位がシャッフルするので黙る）
        if is_race_session and onTrack and class_pos is not None and prev['class_pos'] is not None and class_pos != prev['class_pos']:
            gained = prev['class_pos'] - class_pos
            if gained > 0:
                _pu_msg = random.choice(['P' + str(class_pos) + '.', 'P' + str(class_pos) + ', good pass.',
                    'Position gained. P' + str(class_pos) + '.'])
                broadcast({'type': 'radio', 'trigger': 'position_up', 'pos': class_pos, 'message': _pu_msg})
            else:
                _pd_msg = random.choice(['P' + str(class_pos) + '. Lost one.', 'P' + str(class_pos) + '. He got you, get it back.',
                    'Down to P' + str(class_pos) + '. Stay calm.'])
                broadcast({'type': 'radio', 'trigger': 'position_down', 'pos': class_pos, 'message': _pd_msg})

        # Fuel warning
        # ※実際にトラック走行中＆燃料が有効な数値の時だけ警告する。
        #   ガレージ/ピット/セッション開始直後は燃料0やデータ未取得で誤発火するため除外。
        if driver_state == 'track' and fuel is not None and 0.5 < fuel < 5 \
                and (prev['fuel'] is None or prev['fuel'] >= 5):
            broadcast({'type': 'radio', 'trigger': 'fuel_warning', 'fuel': round(fuel, 1),
                'message': 'Fuel ' + str(round(fuel, 1)) + '. Save mode now.'})

        # Tyre temps: 自動警告は無効化（読んでる変数がカーカス温度で不正確。較正後に復活予定）
        # データ自体は将来デブリーフで参照可能にする

        # Final lap（レースのみ）
        if is_race_session and lapsTot and lap and lapsTot > 0 and lap == lapsTot and lap != prev['lapsTot']:
            broadcast({'type': 'radio', 'trigger': 'final_lap', 'pos': pos,
                'message': 'Final lap. P' + str(pos) + '.'})

        # ── セッションサマリー：チェッカーは「見えた」だけ記録し、送信は自分の完走まで待つ ──
        # SessionState 5=Checkered/6=Cooldownはセッション全体で共有される値——リーダーがチェッカーを
        # 受けた瞬間、まだ走行中の自分も含めて全員が同時にこの状態になる(2026-07-05実走+2026-07-13
        # 再指摘・Yuji確認)。ここで即送信すると自分がまだ周回/半周残っていてもデブリーフに切り替わる。
        # フラグだけ立てて、実際の送信は下のlap_time_changedブロック（＝自分がS/Fラインを実際に
        # 通過した瞬間）まで待つ。レースセッションのみ対象（予選/練習は対象外＝上のガレージ帰還時の
        # 別ルートでサマリーのみ送信、デブリーフ誘導はis_raceフラグでクライアント側が判断する）。
        if is_race_session and cur_ss in (5, 6) and not summary_sent:
            checkered_pending = True

        # ── ⑥ ピットリミッター解除コール（新規・2026-07-14 Yuji要望）──────────────
        # ピットアウトでスピード制限解除ライン(=リミッターが切れる瞬間)に「リミッターオフ」を知らせる。
        # EngineWarningsのpitSpeedLimiterビット(0x10)がON→OFFに落ちた瞬間が実際の解除タイミングで、
        # OnPitRoad判定より正確。ビットが取れない環境でも下のピットアウト転移でフォールバック発火する。
        engine_warnings = reader.read_int('EngineWarnings')
        limiter_on = bool(engine_warnings & 0x10) if engine_warnings is not None else False
        if prev_limiter_on and not limiter_on and onTrack and not limiter_off_announced_stop:
            broadcast({'type': 'radio', 'trigger': 'limiter_off', 'message': 'Limiter off. Go.'})
            limiter_off_announced_stop = True
        prev_limiter_on = limiter_on

        # Pit in/out
        if onPit and not prev['onPit']:
            pit_enter_time = reader.read_double('SessionTime')   # 進入時刻を記録
            pit_enter_pos = class_pos
            limiter_off_announced_stop = False   # 新しいピットストップ＝リミッターオフ再武装
            _pin_msg = random.choice(['Limiter now. Line is close.', 'Pit limiter on, line coming up.', 'Copy, into the box.'])
            broadcast({'type': 'radio', 'trigger': 'pit_entry', 'message': _pin_msg})

        if prev['onPit'] and not onPit and onTrack:
            # ── ピットレーン所要時間を実測（進入→退出のSessionTime差）──
            # 耐久のピットウィンドウ予測(復帰順位・トラフィック回避)の土台。1階記憶に残す。
            pit_lane_sec = None
            if pit_enter_time is not None:
                _now = reader.read_double('SessionTime')
                if _now is not None:
                    pit_lane_sec = round(_now - pit_enter_time, 1)
                pit_enter_time = None
            # ⑥ フォールバック：EngineWarningsのリミッタービットが未検知でこのストップでまだ鳴らして
            # いなければ、ピットレーン退出(OnPitRoad False)の瞬間に「リミッターオフ」を鳴らす。
            if not limiter_off_announced_stop:
                broadcast({'type': 'radio', 'trigger': 'limiter_off', 'message': 'Limiter off. Go.'})
                limiter_off_announced_stop = True
            _pex_msg = random.choice(['Out. P' + str(pos) + '. Tyres one lap.', 'Back on track, P' + str(pos) + '. Warm the tyres up.',
                'Copy, you\'re out. P' + str(pos) + '.'])
            broadcast({'type': 'radio', 'trigger': 'pit_exit', 'pos': pos, 'message': _pex_msg})
            if pit_lane_sec is not None and 5 < pit_lane_sec < 300:  # 妥当範囲のみ(誤検知除外)
                broadcast({'type': 'pit_timing', 'pit_lane_sec': pit_lane_sec,
                           'track': session_track, 'car_class': session_car_class,
                           'pos_in': pit_enter_pos, 'pos_out': class_pos})
                log('PIT timing: lane ' + str(pit_lane_sec) + 's  P' + str(pit_enter_pos) + '->P' + str(class_pos))

        # ── マルチクラス・バトル検知 ────────────────────────────────────
        # CarIdxF2Time = iRacingダッシュボードと同じ相対タイム（EstTimeより正確）
        nearest_ahead_gap = None    # 毎ループ更新（前後の最近接ギャップ）
        nearest_behind_gap = None
        if player_car_idx >= 0 and onTrack and not onPit and not in_formation:
            car_f2_times   = reader.read_float_array('CarIdxF2Time', 64)
            car_last_laps  = reader.read_float_array('CarIdxLastLapTime', 64)
            car_on_track   = reader.read_int_array('CarIdxTrackSurface', 64)
            # CarIdxTrackSurface: -1=NotInWorld, 0=OffTrack, 1=InPitStall, 2=ApproachingPits, 3=OnTrack

            # ── 前後ギャップは CarIdxEstTime（コース上位置を時間で表す）で計算する ──
            # ⚠️旧実装はCarIdxF2Timeの差で計算してたが、F2Timeは「レースはリーダー差・練習/予選は
            #   自己ベストラップ」というiRacing仕様。練習だと"ベストラップの近い車との差"になり、
            #   実際のコース上車間と無関係な値(例0.02秒)が出るバグだった(2026/7/7 実走ログで判明)。
            #   EstTime差なら全セッション種別で"物理的にコース上で一番近い車"との時間差になる。
            car_est_times = reader.read_float_array('CarIdxEstTime', 64)
            if car_est_times and player_car_idx < len(car_est_times):
                p_et = car_est_times[player_car_idx]
                if p_et and p_et > 0:
                    for _ei, _et in enumerate(car_est_times):
                        if _ei == player_car_idx or not _et or _et <= 0:
                            continue
                        if car_on_track and car_on_track[_ei] not in (2, 3):  # コース上/ピット接近のみ
                            continue
                        # ★2026-07-12実走で発覚：CarIdxEstTimeは「今の周回内の経過時間」で周回ごとに
                        #   リセットされる値。周回数が違う(ラップダウン)車同士でも、たまたま周回内の
                        #   同じような位置にいると差が小さく出て「0.3秒差」等の誤検知になる
                        #   （実測：15.5秒離れた車が1秒後に0.0秒と誤警告）。同一周回の車同士でしか使わない。
                        if car_laps_all and lap is not None and _ei < len(car_laps_all) and car_laps_all[_ei] != lap:
                            continue
                        _gd = _et - p_et  # 負=前方(est_timeが小さい), 正=後方
                        if _gd < 0 and -_gd < 30 and (nearest_ahead_gap is None or -_gd < nearest_ahead_gap):
                            nearest_ahead_gap = -_gd
                        elif _gd > 0 and _gd < 30 and (nearest_behind_gap is None or _gd < nearest_behind_gap):
                            nearest_behind_gap = _gd

            # ── 停止/クラッシュ車両検知（コース上・オフトラックで動きが止まってる車）──
            # 1秒おきにLapDistPctの変化をサンプリングし、ほぼ動いてなければ「停止」とみなす。
            car_dist_pct = reader.read_float_array('CarIdxLapDistPct', 64)
            _snow = time.time()
            # CarIdxOnPitRoad: ピットレーン上の車を確実に除外（ホームストレート沿いのピットで
            # 停車中の車をコース上の停止車両と誤検知しないための保険。無ければNoneで無視される）
            car_on_pitroad = reader.read_int_array('CarIdxOnPitRoad', 64)
            if car_dist_pct and _snow - stopped_check_ts > 1.0:
                for _i, _dist in enumerate(car_dist_pct):
                    if _i == player_car_idx or _dist is None or _dist < 0:
                        continue
                    _surf = car_on_track[_i] if car_on_track and _i < len(car_on_track) else -1
                    _onpit = bool(car_on_pitroad[_i]) if car_on_pitroad and _i < len(car_on_pitroad) else False
                    if _surf not in (0, 3) or _onpit:  # ピット関連/未使用の車は対象外
                        car_pos_hist.pop(_i, None); car_stopped_since.pop(_i, None)
                        continue
                    _prev = car_pos_hist.get(_i)
                    if _prev is not None and abs(_dist - _prev[0]) < 0.0004:
                        if _i not in car_stopped_since:
                            car_stopped_since[_i] = _snow
                    else:
                        car_stopped_since.pop(_i, None)
                    car_pos_hist[_i] = (_dist, _snow)
                stopped_check_ts = _snow

            # ── 停止/クラッシュ車両の警告（前方のみ、2秒以上停止確定）──
            # Yuji方針：5秒圏内に入ったら1回だけ知らせる。IR側スポッターと同じ役割。
            # ⚠️2026-07-13実走で一度も発火しないバグが発覚：上のバトル検知ループは
            #   「同一周回の車同士でしか判定しない」フィルターが掛かっており（EstTimeが
            #   周回ごとにリセットされる値のため、異なる周回の車を比較すると誤検知するのが理由）、
            #   前方でスピン/クラッシュした車は高確率で周回数がズレるため、まさに検知したい瞬間に
            #   そのフィルターで弾かれて黙っていた。停止車検知はEstTimeでなくLapDistPct（周回内の
            #   位置%、周回数と無関係）の差で距離を測ることで、周回フィルターを使わずに済む形に分離した。
            # ⚠️後方(stopped_behind)は2026/7/5に廃止。元々はドライバーの心理的プレッシャーを
            # 和らげる目的だったが、武装/解除方式の検知漏れリスクがある機能を安全上クリティカル
            # でない用途に使うのはリスクに見合わない判断。前方(衝突リスクに直結)のみ残す。
            if car_stopped_since and car_dist_pct and player_car_idx < len(car_dist_pct):
                player_pct = car_dist_pct[player_car_idx]
                _car_last_laps_stopped = reader.read_float_array('CarIdxLastLapTime', 64)
                player_last_lap_stopped = (_car_last_laps_stopped[player_car_idx]
                                            if _car_last_laps_stopped and player_car_idx < len(_car_last_laps_stopped) else 0) or 0
                if player_pct is not None and player_pct >= 0 and player_last_lap_stopped > 0:
                    _now2 = time.time()
                    for idx in list(car_stopped_since.keys()):
                        if idx == player_car_idx or idx >= len(car_dist_pct):
                            continue
                        other_pct = car_dist_pct[idx]
                        if other_pct is None or other_pct < 0:
                            continue
                        _stopped_dur = _now2 - car_stopped_since.get(idx, _now2)
                        if _stopped_dur < 2.0:
                            continue
                        pct_diff = other_pct - player_pct  # 正=相手が前方（周回内の位置で判定、周回数は無視）
                        if pct_diff > 0.5: pct_diff -= 1.0
                        elif pct_diff < -0.5: pct_diff += 1.0
                        if pct_diff <= 0:  # 前方でなければ対象外
                            continue
                        _sdist = pct_diff * player_last_lap_stopped
                        if _sdist > 6.0:
                            stopped_armed[idx] = True
                        elif _sdist <= 5.0 and stopped_armed.get(idx, False):
                            _lastw = stopped_warned.get(idx, 0)
                            if _now2 - _lastw > 20 and _now2 - last_battle_global > 15:
                                broadcast({'type': 'radio', 'trigger': 'stopped_ahead',
                                    'delta': round(_sdist, 1),
                                    'message': 'Stopped car ahead, ' + _fmt_gap(_sdist) + '.'})
                                stopped_armed[idx] = False
                                stopped_warned[idx] = _now2
                                last_battle_global = _now2

            if car_f2_times and player_car_idx < len(car_f2_times):
                player_time     = car_f2_times[player_car_idx]
                player_last_lap = car_last_laps[player_car_idx] if car_last_laps else 0
                now = time.time()
                # ⚠️接近判定(バトル/危険/停止車)は EstTime(コース上位置)で車間を測る。
                #   F2Timeは練習/予選だと各車の自己ベスト差になり、実際の車間と無関係(8秒/15秒等の
                #   デタラメ警告の原因・2026/7/7 Yuji指摘)。EstTime差なら全セッションで正しい車間。
                player_est = car_est_times[player_car_idx] if (car_est_times and player_car_idx < len(car_est_times)) else None
                # クラス内順位（車の識別をゼッケンでなく「クラス名+順位」で言うため・Yuji方針2026-07-14）
                car_class_pos_arr = reader.read_int_array('CarIdxClassPosition', 64)

                for idx, f2_time in enumerate(car_f2_times):
                    if idx == player_car_idx or f2_time <= 0:
                        continue
                    # ★同一周回の車同士でしか接近判定しない（上のnearest_gapブロックと同じ理由・
                    #   2026-07-12実走で発覚したEstTimeの周回またぎ誤検知対策）。
                    if car_laps_all and lap is not None and idx < len(car_laps_all) and car_laps_all[idx] != lap:
                        continue
                    # ※前後ギャップ(nearest_ahead/behind_gap)は上のCarIdxEstTimeブロックで計算済み。
                    #   このループはバトル/接近/停止車検知に使う。車間はEstTime差で測る。
                    other_est = car_est_times[idx] if (car_est_times and idx < len(car_est_times)) else None
                    if not player_est or player_est <= 0 or not other_est or other_est <= 0:
                        continue  # コース上位置が不明な車は接近判定しない（誤警告防止）
                    _d = other_est - player_est  # 負=前方, 正=後方

                    # ピット/ガレージの車は完全除外（接近警告を出さない）
                    if car_on_track:
                        surf = car_on_track[idx]
                        if surf not in (2, 3):  # 2=ApproachingPits, 3=OnTrack のみ対象
                            continue

                    # コース上の車間（EstTime差）。プラス=相手が後方、マイナス=相手が前方。
                    delta = _d
                    est_time = f2_time  # 後続コードの互換性のため（未使用でも残す）

                    other_class = car_class_map.get(idx, -1)
                    other_rel   = car_relspeed_map.get(idx, 0)

                    # ── マルチクラス接近警告（GTP/LMP2等が後方接近）2段階コール ──
                    # ※車が0-2秒圏内に張り付いたまま(同クラス列走行等)だと単純タイマーでは
                    #   永遠に再発火してしまうため、再武装(armed)方式に変更＝1回の接近につき
                    #   approaching→imminentを最大1回ずつ。6秒より離れたら再武装。
                    is_faster_class = (other_class != -1 and other_class != player_class_id and
                                       other_rel > player_rel_speed)
                    # 診断ログ：別クラスの車が5秒以内に近いのに「速いクラス」と判定されなかった
                    # ケースを記録（Yuji報告「GTP接近でコールゼロ」の原因特定用・10秒に1回まで）
                    if (other_class != -1 and other_class != player_class_id and not is_faster_class
                            and abs(delta) <= 5.0 and now - last_mc_diag_ts > 10):
                        log("MC-DIAG no-call: my_class=%s my_rel=%s other_class=%s other_rel=%s delta=%.1f" %
                            (player_class_id, player_rel_speed, other_class, other_rel, delta))
                        last_mc_diag_ts = now
                    if is_faster_class:
                        if delta > 6.0:
                            multiclass_armed[idx] = True
                        elif 2.0 < delta <= 5.0 and multiclass_armed.get(idx, False):  # 5秒前：第1コール
                            last_warn = multiclass_warned.get(idx, 0)
                            if now - last_warn > 15:
                                other_cls_pos = car_class_pos_arr[idx] if car_class_pos_arr and idx < len(car_class_pos_arr) else None
                                other_cls_name = car_class_name_map.get(idx)
                                broadcast({'type': 'radio', 'trigger': 'multiclass_approaching',
                                    'delta': round(delta, 1), 'class_name': _norm_class_name(other_cls_name), 'class_pos': other_cls_pos,
                                    'message': _class_id_txt_en(other_cls_name, other_cls_pos) + ' back, ' + _fmt_gap(delta) + '. Prepare.'})
                                multiclass_warned[idx] = now
                        elif 0 < delta <= 2.0 and multiclass_armed.get(idx, False):  # 2秒前：第2コール（緊急・1回のみ）
                            broadcast({'type': 'radio', 'trigger': 'multiclass_imminent',
                                'delta': round(delta, 1),
                                'message': 'Give room. Now.'})
                            multiclass_2s_warned[idx] = now
                            multiclass_armed[idx] = False  # 再武装まで両方とも黙る

                    # ── 危険ドライバー警告（低iRating/低SR、前後どちらも）──────────
                    # Yuji方針：バトル警告と同じタイミング(0.55→0.3の急接近で1回だけ)に乗せる。
                    other_irating = car_irating_map.get(idx, 0)
                    other_sr = car_sr_map.get(idx)
                    is_risky = (0 < other_irating < 1500) or (other_sr is not None and 1.0 <= other_sr <= 2.5)
                    if is_risky and not in_start_rush and idx not in danger_ever_warned:
                        # 危険ドライバーは早めの安全予告なので3秒圏内で1回（バトルの0.3秒より広い）
                        # ⚠️このドライバーへの警告はセッション中1回のみ(danger_ever_warned)。
                        # 再武装方式だとギャップが4秒→3秒を何度も往復するだけで同じ相手に何度も鳴ってしまい
                        # 鬱陶しい(Yuji実走指摘・2026/7/5)。同一車には二度と警告しない。
                        adist = abs(delta)
                        if adist > 4.0:
                            ahead_armed[idx] = True
                        elif adist <= 3.0 and ahead_armed.get(idx, False):
                            last_warn = danger_warned.get(idx, 0)
                            if now - last_warn > 20 and now - last_battle_global > 15:
                                reason = 'SR ' + str(other_sr) if (other_sr is not None and other_sr <= 2.5) else 'iR ' + str(other_irating)
                                # ゼッケンが取れてれば認識度アップのため文言に含める(Yuji方針・2026/7/14)。
                                # 無ければ黙って省略(ゼッケン無し表記で捏造しない)。
                                num = car_number_map.get(idx)
                                car_tag = (' car #' + num) if num else ''
                                # 診断：どのidxに、どの番号/SR/iRを紐付けて鳴らしたか（ゼッケンSR不一致調査）
                                log("DANGER fire idx=" + str(idx) + " #" + str(num) + " SR=" + str(other_sr)
                                    + " iR=" + str(other_irating) + " -> reason:" + reason)
                                if delta > 0:  # 相手が後方（delta>0=後方）
                                    broadcast({'type': 'radio', 'trigger': 'danger_behind',
                                        'delta': round(delta, 1), 'reason': reason, 'car_number': num,
                                        'message': 'Careful.' + car_tag + ' Risky driver behind (' + reason + ').'})
                                else:  # 相手が前方
                                    broadcast({'type': 'radio', 'trigger': 'danger_ahead',
                                        'delta': round(abs(delta), 1), 'reason': reason, 'car_number': num,
                                        'message': 'Careful passing —' + car_tag + ' risky driver ahead (' + reason + ').'})
                                ahead_armed[idx] = False
                                danger_warned[idx] = now
                                danger_ever_warned.add(idx)
                                last_battle_global = now

                    # ── 同クラス：後ろが"急接近した瞬間"だけ1回警告（連呼しない）──────────
                    # 前方の車は離れても迫っても見えてるので黙る（Yuji方針）。
                    # 後ろは死角。一度クリア(>3.0=本当に引き離した)だった車が接近(<=0.3)した最初の1回だけ「後ろ注意」。
                    # ⚠️再武装の閾値は元々0.55秒だったが、同じバトルの中で車間が一瞬開閉するだけで
                    #   再発火して連呼になる問題が実走で判明(Yuji指摘・2026/7/14)。「本当に引き離した」と
                    #   言えるレベルまで閾値を上げて、ただの車間の揺らぎでは再武装しないようにした。
                    #   同じ相手が一度クリアな状態を経て再接近した場合(＝ミスで下がって終盤また来た等)は
                    #   "再接近"として言い方を変える(battle_ever_warned)。
                    if is_race_session and other_class == player_class_id and not in_start_rush and delta > 0:
                        if delta > 3.0:
                            behind_armed[idx] = True  # 本当に引き離した＝次の接近で警告できる状態に
                        elif delta <= 0.3 and behind_armed.get(idx, False):
                            if now - last_battle_global > 15:
                                other_last_lap = car_last_laps[idx] if car_last_laps else 0
                                pace_diff = (other_last_lap - player_last_lap
                                             if other_last_lap > 0 and player_last_lap > 0 else 0)
                                is_repeat = idx in battle_ever_warned
                                num = car_number_map.get(idx)
                                car_tag = (' car #' + num) if num else ''
                                again_tag = ' again' if is_repeat else ''
                                if pace_diff < -1.5:  # 相手が明らかに速い → 抑えるより先に行かせる
                                    broadcast({'type': 'radio', 'trigger': 'battle_behind_faster',
                                        'delta': round(delta, 1), 'pace': round(abs(pace_diff), 2), 'repeat': is_repeat,
                                        'message': 'Behind' + car_tag + again_tag + '. ' + _fmt_gap(delta) + '. Faster pace. Let him go.'})
                                else:
                                    broadcast({'type': 'radio', 'trigger': 'battle_behind',
                                        'delta': round(delta, 1), 'repeat': is_repeat,
                                        'message': 'Behind' + car_tag + again_tag + '. ' + _fmt_gap(delta) + '. Closing.'})
                                behind_armed[idx] = False   # 1回言ったら再武装まで黙る
                                battle_ever_warned.add(idx)
                                last_battle_global = now

                    # ── 段階的キャッチアップ/ディフェンスコール（2026-07-14 Yuji設計→同日実走で再調整）──
                    # 単純な車間だけでなく「本当に追いつけそうか」をペース差(pace_diff)で判定してから、
                    # 10→7→3→1.5秒の閾値を跨いだ最初の瞬間だけ1回鳴らす。
                    # ⚠️実走(IMSA Fixed)で1レース59回発火の大惨事が判明・2点を修正:
                    #   ①別クラス車も対象にしてたため、既存のmulticlass_approaching/imminentと完全に重複
                    #     (GTPが専用の仕組みを差し置いてこっちで発火してた)。同クラス限定に変更。
                    #   ②再武装の閾値(10秒で仕切り直し)が敏感すぎて、パックレースで車間が9〜11秒を
                    #     うろつくたびに何度も再発火。15秒まで引き離すまで待つよう変更(battle_behindと同じ教訓)。
                    # あと「後方7.3秒でミラー確認」のような、実際の緊急度と釣り合わないアドバイスも指摘された。
                    # 遠い段階(10/7秒)は数字だけ、行動の指示(ミラー確認・仕掛けろ)は1.5秒以下でのみ言う。
                    # ⚠️③自分のクラス内順位から見て「隣の順位」の車だけを対象にする(Yuji方針・2026-07-14再調整)。
                    #   同じクラスで車間閾値内の車全部を追跡すると、パックレースで複数台が同時に
                    #   引っかかって「乱れ打ち」になる。隣の順位＝実質的に一番意味のあるライバルなので
                    #   これ1台に絞れば粒度も自然に落ち着く。識別もゼッケンでなく「クラス名+順位」に統一
                    #   (例:GT3 1位)——ゼッケンは覚えにくいが順位は文脈的にすぐ分かるとの指摘。
                    other_cls_pos = car_class_pos_arr[idx] if car_class_pos_arr and idx < len(car_class_pos_arr) else None
                    is_adjacent_rival = (other_cls_pos is not None and class_pos is not None
                                          and other_cls_pos in (class_pos - 1, class_pos + 1))
                    if is_race_session and other_class == player_class_id and not in_start_rush and is_adjacent_rival:
                        other_last_lap2 = car_last_laps[idx] if car_last_laps else 0
                        pace_diff2 = (other_last_lap2 - player_last_lap
                                      if other_last_lap2 > 0 and player_last_lap > 0 else None)
                        car_tag2 = _class_id_txt_en(car_class_name_map.get(idx), other_cls_pos) + ', '

                        if delta < 0:  # 相手が前方＝キャッチアップ対象
                            gap = abs(delta)
                            if gap > 15.0:
                                catchup_stage[idx] = 0
                            elif pace_diff2 is not None and pace_diff2 > 0.3:
                                prev_pace = gap_pace_hist.get(('ahead', idx))
                                gap_pace_hist[('ahead', idx)] = pace_diff2
                                confident = prev_pace is not None and prev_pace > 0.3
                                stage = _catchup_stage_of(gap)
                                if stage > catchup_stage.get(idx, 0) and now - last_battle_global > 15:
                                    catchup_stage[idx] = stage
                                    if stage <= 2:
                                        stage_txt = ''
                                    elif stage == 3:
                                        stage_txt = ' Closing in.' if confident else ' Early to tell.'
                                    else:
                                        stage_txt = ' Go for it.'
                                    broadcast({'type': 'radio', 'trigger': 'catchup_ahead', 'stage': stage,
                                        'delta': round(gap, 1), 'class_name': _norm_class_name(car_class_name_map.get(idx)), 'class_pos': other_cls_pos, 'confident': confident,
                                        'message': 'Ahead, ' + car_tag2 + 'within ' + _fmt_gap(gap) + '.' + stage_txt})
                                    last_battle_global = now
                        else:  # 相手が後方＝ディフェンス対象
                            gap = delta
                            if gap > 15.0:
                                defend_stage[idx] = 0
                            elif pace_diff2 is not None and pace_diff2 < -0.3:
                                prev_pace = gap_pace_hist.get(('behind', idx))
                                gap_pace_hist[('behind', idx)] = pace_diff2
                                confident = prev_pace is not None and prev_pace < -0.3
                                stage = _catchup_stage_of(gap)
                                if stage > defend_stage.get(idx, 0) and now - last_battle_global > 15:
                                    defend_stage[idx] = stage
                                    if stage <= 2:
                                        stage_txt = ''
                                    elif stage == 3:
                                        stage_txt = ' Closing.' if confident else ' Early to tell.'
                                    else:
                                        stage_txt = ' Check mirrors.'
                                    broadcast({'type': 'radio', 'trigger': 'defend_behind', 'stage': stage,
                                        'delta': round(gap, 1), 'class_name': _norm_class_name(car_class_name_map.get(idx)), 'class_pos': other_cls_pos, 'confident': confident,
                                        'message': 'Behind, ' + car_tag2 + 'within ' + _fmt_gap(gap) + '.' + stage_txt})
                                    last_battle_global = now

        # ── クラス内・任意順位とのギャップ（項目：まーぼー要望「3rd/5thとのギャップ」2026-07-14）──
        # 今までは「直前直後の車」としか比較できず、離れた順位を聞かれると答えられなかった。
        # CarIdxF2Timeはレースセッション中は「リーダーからの遅れ」を表す値(iRacingダッシュボードと同じ)で、
        # 周回数が違う車同士でも(EstTimeと違って)そのまま引き算して正しいギャップになる。
        # なのでレース中のみ、クラス内の全順位について{順位: 自分とのギャップ秒}を作って毎回同送する。
        standings_gaps = None
        if is_race_session and player_car_idx >= 0:
            _cls_pos_arr = reader.read_int_array('CarIdxClassPosition', 64)
            _f2_arr = reader.read_float_array('CarIdxF2Time', 64)
            if _cls_pos_arr and _f2_arr and player_car_idx < len(_f2_arr):
                _player_f2 = _f2_arr[player_car_idx]
                if _player_f2 is not None and _player_f2 >= 0:
                    standings_gaps = {}
                    for _si, _spos in enumerate(_cls_pos_arr):
                        if not _spos or _spos <= 0 or car_class_map.get(_si, -1) != player_class_id:
                            continue
                        if _si >= len(_f2_arr) or _f2_arr[_si] is None or _f2_arr[_si] < 0:
                            continue
                        standings_gaps[str(_spos)] = round(_f2_arr[_si] - _player_f2, 1)

        # ── ライブテレメトリ・スナップショット（数秒おき・エンジニアが実値で答えるため）──
        # これが無いと「順位は？」「燃料残量は？」に推測（捏造）で答えてしまう。実値を脳へ渡す。
        # ※onTrack限定にしない：ピット/ガレージでの直後デブリーフでもデータが古くなり
        #   すぎないよう、走行中でなくても(session接続中は)更新し続ける。
        _tnow = time.time()
        if player_car_idx >= 0 and _tnow - last_telem_ts > 3:
            broadcast({
                'type': 'telemetry_live',
                'class_pos': class_pos,
                'pos': pos,
                'fuel': round(fuel, 1) if fuel is not None else None,
                'best': round(personal_best, 3) if personal_best else None,
                'last': round(lapTime, 3) if (lapTime and lapTime > 0) else None,
                'lap': lap,
                'laps_total': lapsTot if (lapsTot and lapsTot > 0) else None,
                'gap_ahead': round(nearest_ahead_gap, 2) if nearest_ahead_gap is not None else None,
                'gap_behind': round(nearest_behind_gap, 2) if nearest_behind_gap is not None else None,
                'on_track': onTrack,
                'fuel_strategy': fuel_strategy,
                'tires': tires,
                'damage_s': damage_s,
                'weather': weather,
                'standings_gaps': standings_gaps,
            })
            last_telem_ts = _tnow

        prev.update({'pos': pos, 'class_pos': class_pos, 'fuel': fuel, 'lap': lap,
                     'lapsTot': lapsTot, 'onPit': onPit})
        time.sleep(0.1)  # 0.1秒ポーリング = コントロールライン通過を0.1秒以内に検知


# 保存済みのボタン割当を「今接続されているジョイスティック」から解決する。
#   index（接続順）だけで照合すると、機材を増やしたりUSB挿し直しで順番が変わった時に
#   別デバイスのボタンを静かに監視し続けてしまい、押しても何も起きない“無言の故障”になる
#   （2026-07-11の耐久レースで実際に発生：4時間PTTが一度も発火せず気づかれなかった）。
#   デバイス名が保存されていれば名前で優先照合し、順番が変わっても壊れないようにする。
#   旧形式（nameフィールドが無い設定ファイル）は今まで通りindexを信頼（後方互換）。
def _resolve_bound_joy(binding, sticks):
    if not binding:
        return None
    bname = binding.get("name")
    if bname:
        for idx, js in sticks.items():
            if js.get_name() == bname:
                return idx
        return None
    bjoy = binding.get("joy")
    return bjoy if bjoy in sticks else None


# ── ジョイスティック/ハンドル監視（PTT用・フルスクリーン裏でも動く）──
# pygameでボタンを直接読む。フォーカス不要＝iRacingがフルスクリーンでも検出できる。
def poll_joystick():
    global ptt_capturing, ptt_pressed, ptt_binding, vol_capturing, ptt_mismatch_warned
    try:
        os.environ.setdefault("SDL_VIDEODRIVER", "dummy")  # 画面不要
        # フォーカスが無く（iRacingがフルスクリーン前面）てもジョイスティック入力を受け取る
        os.environ["SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS"] = "1"
        import pygame
        pygame.init()
        pygame.joystick.init()
    except Exception as e:
        log("PTT joystick disabled (pygame unavailable): " + str(e))
        return

    sticks = {}
    last_scan = 0
    log("PTT joystick monitor started")

    while True:
        try:
            try:
                pygame.event.pump()
            except Exception:
                pass
            now = time.time()
            # 接続スキャン（ホットプラグ対応）2秒ごと
            if now - last_scan > 2:
                last_scan = now
                cnt = pygame.joystick.get_count()
                for i in range(cnt):
                    if i not in sticks:
                        try:
                            js = pygame.joystick.Joystick(i)
                            js.init()
                            sticks[i] = js
                            log("PTT: joystick %d connected: %s (%d buttons)" % (i, js.get_name(), js.get_numbuttons()))
                        except Exception:
                            pass

            # 各ジョイスティックのボタン読み取り
            for i, js in list(sticks.items()):
                try:
                    nb = js.get_numbuttons()
                except Exception:
                    continue
                for b in range(nb):
                    try:
                        pressed = js.get_button(b) == 1
                    except Exception:
                        continue
                    if not pressed:
                        continue
                    # 設定モード：押された最初のボタンを登録
                    if ptt_capturing:
                        ptt_binding = {"joy": i, "button": b, "name": js.get_name()}
                        save_ptt_config()
                        ptt_capturing = False
                        ptt_mismatch_warned = False
                        broadcast({'type': 'ptt_set', 'joy': i, 'button': b})
                        log("PTT bound: joystick %d button %d (%s)" % (i, b, js.get_name()))
                    # 音量ボタン設定モード（up/down）：押されたボタンをその方向に登録
                    elif vol_capturing in ("up", "down"):
                        vol_binding[vol_capturing] = {"joy": i, "button": b, "name": js.get_name()}
                        save_vol_config()
                        broadcast({'type': 'vol_set', 'dir': vol_capturing, 'joy': i, 'button': b})
                        log("VOL bound: %s -> joystick %d button %d (%s)" % (vol_capturing, i, b, js.get_name()))
                        vol_capturing = None

            # 登録済みボタンの押下/離しを監視 → PTTイベント送信（デバイス名優先で解決）
            resolved_joy = _resolve_bound_joy(ptt_binding, sticks)
            if ptt_binding:
                if resolved_joy is not None:
                    ptt_mismatch_warned = False
                elif ptt_binding.get("name") and not ptt_mismatch_warned:
                    # 登録した名前のデバイスが見つからない＝押しても永久に無反応になる状態。
                    # ここで黙らず必ず知らせる（無言の故障が一番怖い）。
                    broadcast({'type': 'ptt_mismatch', 'expected_name': ptt_binding.get("name")})
                    log("PTT: bound device not found (" + ptt_binding.get("name") + ") — rebind needed")
                    ptt_mismatch_warned = True
            if resolved_joy is not None:
                js = sticks[resolved_joy]
                try:
                    cur = js.get_button(ptt_binding["button"]) == 1
                except Exception:
                    cur = False
                if cur and not ptt_pressed:
                    ptt_pressed = True
                    broadcast({'type': 'ptt', 'state': 'down'})
                elif not cur and ptt_pressed:
                    ptt_pressed = False
                    broadcast({'type': 'ptt', 'state': 'up'})

            # 音量ボタン監視：押した瞬間（立ち上がりエッジ）に1段変更を送る。
            # ダイヤル（ロータリー）は1クリック=1パルスなので、回すたびに1段動く。
            for d in ("up", "down"):
                bind = vol_binding.get(d)
                rj = _resolve_bound_joy(bind, sticks)
                if rj is not None:
                    js = sticks[rj]
                    try:
                        cur = js.get_button(bind["button"]) == 1
                    except Exception:
                        cur = False
                    if cur and not vol_pressed[d]:
                        vol_pressed[d] = True
                        broadcast({'type': 'volume', 'dir': d})
                    elif not cur and vol_pressed[d]:
                        vol_pressed[d] = False

            time.sleep(0.03)  # 約33Hzで監視（押下を即検知）
        except Exception:
            time.sleep(0.2)


async def handler(websocket):
    global ptt_capturing, ptt_lang, vol_capturing
    connected_clients.add(websocket)
    log("Browser connected (" + str(len(connected_clients)) + " client)")
    try:
        await websocket.send(json.dumps({'type': 'connected'}))
        # 現在のPTT設定・音量ボタン設定を通知
        await websocket.send(json.dumps({'type': 'ptt_config', 'binding': ptt_binding}))
        await websocket.send(json.dumps({'type': 'vol_config', 'binding': vol_binding}))
        # クライアントからのコマンド受信（PTT設定など）
        async for raw in websocket:
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            cmd = msg.get('cmd')
            # log_line = rendererからの会話ログ転送。デバッグログに会話(AI返答含む)を残す。
            # スクショ無しで後から会話を追えるように(Yuji時短)。CMDノイズは出さない。
            if cmd == 'log_line':
                log("CONVO " + str(msg.get('text', '')))
                continue
            log("CMD received: " + str(cmd))
            if cmd == "ptt_start":
                lang = msg.get('lang')
                if lang:
                    ptt_lang = lang
                    log("PTT STT language -> " + str(lang))
                start_ptt_record()
            elif cmd == "ptt_stop":
                stop_ptt_record()
            elif cmd == 'ptt_setup':
                ptt_capturing = True
                log("PTT setup mode: waiting for button press")
            elif cmd == 'ptt_cancel':
                ptt_capturing = False
            elif cmd == 'vol_setup':
                which = msg.get('dir')
                if which in ('up', 'down'):
                    vol_capturing = which
                    log("VOL setup mode (%s): waiting for button press" % which)
            elif cmd == 'vol_cancel':
                vol_capturing = None
    finally:
        connected_clients.discard(websocket)

async def main():
    global loop
    loop = asyncio.get_running_loop()
    # ⚠️以前は"w"(上書き)で起動毎にログを消していた→アプリ再起動(バグ対処等)すると
    # 直前セッションの記録が消え、後から原因診断できなくなる問題があった(2026/7/5判明)。
    # 追記＋セッション区切りマークに変更し、複数起動をまたいで履歴を残す。
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write("\n=== OMORAY PITWALL Bridge session start (BUILD " + BUILD_VERSION + ") ===\n")
    except Exception:
        pass
    load_ptt_config()
    load_vol_config()
    t = threading.Thread(target=poll_iracing, daemon=True)
    t.start()
    tj = threading.Thread(target=poll_joystick, daemon=True)
    tj.start()
    # マイクキャプチャスレッド起動（pyaudio）
    init_mic()
    tm = threading.Thread(target=record_ptt_audio, daemon=True)
    tm.start()
    print("OMORAY PITWALL Bridge  BUILD " + BUILD_VERSION + "  started")
    print("WebSocket: ws://localhost:" + str(PORT))
    log("Waiting for iRacing...")
    async with websockets.serve(handler, "localhost", PORT):
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())
