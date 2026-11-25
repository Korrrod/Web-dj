#!/bin/bash
cd "$(dirname "$0")"
if [ -d "SwingDJ" ]; then
    cd "SwingDJ"
fi
python3 server.py
EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ] && [ $EXIT_CODE -ne 130 ]; then
    echo ""
    read -p "Произошла ошибка (код $EXIT_CODE). Нажмите Enter, чтобы закрыть окно..."
fi
