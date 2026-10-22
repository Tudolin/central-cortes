import os
import re


def sanitize_filename(filename):
    # Remove caracteres inválidos para nomes de arquivo
    return re.sub(r'[\\/*?:"<>|]', "", filename)

def format_time(seconds):
    # Converte segundos para formato MM:SS
    minutes = int(seconds // 60)
    seconds = int(seconds % 60)
    return f"{minutes:02d}:{seconds:02d}"