import os
import re
import traceback

import yt_dlp as youtube_dl
from pytube import YouTube
from pytube.exceptions import RegexMatchError, VideoUnavailable

from src.utils import sanitize_filename


class YouTubeDownloader:
    def __init__(self, url):
        self.url = self._validate_and_clean_url(url)
        
    def _validate_and_clean_url(self, url):
        """Valida e limpa a URL do YouTube"""
        # Verifica se é uma URL do YouTube válida
        if not re.match(r'^(https?\:\/\/)?(www\.)?(youtube\.com|youtu\.?be)\/.+', url):
            raise ValueError("URL do YouTube inválida")
            
        # Remove parâmetros desnecessários e mantém apenas o ID do vídeo
        if 'youtu.be' in url:
            video_id = url.split('/')[-1].split('?')[0]
        else:
            video_id = url.split('v=')[1].split('&')[0]
            
        return f'https://www.youtube.com/watch?v={video_id}'

    def _download_with_pytube(self):
        """Tenta baixar usando pytube"""
        try:
            print("\nTentando baixar com pytube...")
            yt = YouTube(self.url)
            
            # Pega a melhor stream progressiva (áudio + vídeo)
            stream = yt.streams.filter(progressive=True, file_extension='mp4').order_by('resolution').desc().first()
            if not stream:
                raise Exception("Nenhuma stream MP4 progressiva disponível")
            
            # Cria diretório de downloads se não existir
            os.makedirs("downloads", exist_ok=True)
            
            # Define o nome do arquivo
            filename = f"{sanitize_filename(yt.title)}.mp4"
            output_path = os.path.join("downloads", filename)
            
            # Faz o download
            stream.download(output_path="downloads", filename=filename)
            
            print(f"Download concluído com pytube: {output_path}")
            return output_path
            
        except Exception as e:
            print(f"Falha no pytube: {str(e)}")
            traceback.print_exc()
            return None

    def _download_with_ytdlp(self):
        """Tenta baixar usando yt-dlp como fallback"""
        try:
            print("\nTentando baixar com yt-dlp...")
            ydl_opts = {
                # Baixa apenas o melhor formato MP4 progressivo (áudio + vídeo juntos)
                'format': 'best[ext=mp4]/best',
                'outtmpl': 'downloads/%(title)s.%(ext)s',
                'quiet': True,
                'no_warnings': True,
                'extract_flat': False,
                'force_generic_extractor': False,
            }
            
            # Cria diretório de downloads se não existir
            os.makedirs("downloads", exist_ok=True)
            
            with youtube_dl.YoutubeDL(ydl_opts) as ydl:
                info_dict = ydl.extract_info(self.url, download=True)
                filename = ydl.prepare_filename(info_dict)
                
                # Verifica se o arquivo foi baixado corretamente
                if not os.path.exists(filename):
                    raise FileNotFoundError("Arquivo não foi baixado corretamente")
                
                # Garante a extensão .mp4
                base, ext = os.path.splitext(filename)
                if ext.lower() != '.mp4':
                    new_filename = base + '.mp4'
                    os.rename(filename, new_filename)
                    filename = new_filename
                
                print(f"Download concluído com yt-dlp: {filename}")
                return filename
                
        except Exception as e:
            print(f"Falha no yt-dlp: {str(e)}")
            traceback.print_exc()
            return None

    def download(self):
        """Tenta baixar o vídeo com ambos os métodos"""
        try:
            # Primeiro tenta com pytube
            result = self._download_with_pytube()
            if result and os.path.exists(result):
                return result
                
            # Se pytube falhar, tenta com yt-dlp
            result = self._download_with_ytdlp()
            if result and os.path.exists(result):
                return result
                
            print("\nErro: Não foi possível baixar o vídeo com nenhum método")
            return None
            
        except Exception as e:
            print(f"Erro fatal: {str(e)}")
            traceback.print_exc()
            return None