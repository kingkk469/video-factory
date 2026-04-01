"""工具函数：session 读写、JSON Lines 日志输出"""
import json
import os
import sys


def log(message: str, type_: str = "progress"):
    print(json.dumps({"type": type_, "message": message}, ensure_ascii=False), flush=True)


def done(key: str, value):
    print(json.dumps({"type": "done", "key": key, "value": value}, ensure_ascii=False), flush=True)


def error(message: str):
    print(json.dumps({"type": "error", "message": message}, ensure_ascii=False), flush=True)
    sys.exit(1)


def read_session(session_path: str) -> dict:
    with open(session_path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_session(session_path: str, data: dict):
    with open(session_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def update_session(session_path: str, updates: dict):
    data = read_session(session_path)
    data.update(updates)
    write_session(session_path, data)
    return data


def get_env(key: str, default: str = "") -> str:
    return os.environ.get(key, default)


def safe_path(path_str: str, session_dir: str) -> str:
    """
    如果路径含非ASCII字符（中文等），复制到 session_dir 下并返回新路径。
    否则直接返回原路径。这样 ffmpeg 命令行不会乱码。
    每次都复制并覆盖，避免不同文件使用相同缓存名。
    """
    try:
        path_str.encode('ascii')
        return path_str
    except UnicodeEncodeError:
        pass
    ext = os.path.splitext(path_str)[1]
    ascii_name = f"_tmp_input{ext}"
    dest = os.path.join(session_dir, ascii_name)
    # 每次都复制并覆盖，确保使用最新的文件
    import shutil
    shutil.copy2(path_str, dest)
    return dest
