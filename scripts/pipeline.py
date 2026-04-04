#!/usr/bin/env python3
"""
统一入口：根据 --step 参数分发到各步骤模块
用法: python pipeline.py --step extract --session path/to/session.json
"""
import argparse
import sys
import os

# 强制 stdout/stderr 使用 UTF-8，避免 Windows GBK 编码错误
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

# 确保 scripts 目录在 path 中
sys.path.insert(0, os.path.dirname(__file__))

STEPS = ["extract", "rewrite", "title", "audio", "video", "subtitle", "edit", "cover"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--step", required=True, choices=STEPS)
    parser.add_argument("--session", required=True)
    args = parser.parse_args()

    if not os.path.exists(args.session):
        from vf_utils import error
        error(f"session 文件不存在: {args.session}")

    if args.step == "extract":
        import extract
        extract.run(args.session)
    elif args.step == "rewrite":
        import rewrite
        rewrite.run(args.session)
    elif args.step == "title":
        import title
        title.run(args.session)
    elif args.step == "audio":
        import audio
        audio.run(args.session)
    elif args.step == "video":
        import video
        video.run(args.session)
    elif args.step == "subtitle":
        import subtitle
        subtitle.run(args.session)
    elif args.step == "edit":
        import edit
        edit.run(args.session)
    elif args.step == "cover":
        import cover
        cover.run(args.session)


if __name__ == "__main__":
    main()
