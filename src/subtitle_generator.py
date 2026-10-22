import os
import tempfile
import traceback

import speech_recognition as sr
from pydub import AudioSegment

from src.utils import format_time


class SubtitleGenerator:
    def __init__(self, video_path, language='pt'):
        self.video_path = video_path
        self.language = language
        self.recognizer = sr.Recognizer()
        self._configure_ffmpeg()
        
    def _configure_ffmpeg(self):
        """Configura os caminhos do FFmpeg/FFprobe e mostra qual está sendo usado"""
        custom_ffmpeg = os.environ.get("FFMPEG_PATH", r"C:\ffmpeg\bin\ffmpeg.exe")
        custom_ffprobe = os.environ.get("FFPROBE_PATH", r"C:\ffmpeg\bin\ffprobe.exe")
        ffmpeg_ok = os.path.exists(custom_ffmpeg)
        ffprobe_ok = os.path.exists(custom_ffprobe)
        if ffmpeg_ok and ffprobe_ok:
            AudioSegment.converter = custom_ffmpeg
            AudioSegment.ffprobe = custom_ffprobe
            print(f"Usando FFmpeg: {custom_ffmpeg}")
            print(f"Usando FFprobe: {custom_ffprobe}")
        else:
            AudioSegment.converter = "ffmpeg"
            AudioSegment.ffprobe = "ffprobe"
            print("FFmpeg/FFprobe não encontrados nos caminhos personalizados. Usando PATH do sistema.")
            print("Certifique-se de que ffmpeg e ffprobe estão instalados e disponíveis no PATH.")
        
    def _extract_audio(self):
        """Extrai áudio do vídeo com tratamento de erros"""
        try:
            # Usa um arquivo temporário para evitar problemas de permissão
            with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as temp_file:
                audio_path = temp_file.name
            
            print(f"Extraindo áudio para: {audio_path}")
            audio = AudioSegment.from_file(self.video_path)
            audio.export(audio_path, format="wav")
            return audio_path
            
        except Exception as e:
            print(f"Erro ao extrair áudio: {str(e)}")
            print("Verifique se ffmpeg e ffprobe estão instalados e configurados corretamente.")
            traceback.print_exc()
            return None

    def generate(self):
        """Gera legendas com tratamento robusto de erros"""
        subtitles = []
        audio_path = None
        
        try:
            audio_path = self._extract_audio()
            if not audio_path or not os.path.exists(audio_path):
                raise Exception("Falha ao extrair áudio do vídeo")
            
            # Verifica o tamanho do arquivo de áudio
            file_size = os.path.getsize(audio_path)
            if file_size == 0:
                raise Exception("Arquivo de áudio vazio")
            
            print(f"Processando áudio ({file_size} bytes)...")
            
            with sr.AudioFile(audio_path) as source:
                audio_duration = len(AudioSegment.from_wav(audio_path)) / 1000
                chunk_size = 5  # segundos
                
                for i in range(0, int(audio_duration), chunk_size):
                    try:
                        audio_chunk = self.recognizer.record(source, duration=chunk_size, offset=i)
                        text = self.recognizer.recognize_google(audio_chunk, language=self.language)
                        
                        subtitles.append({
                            'text': text,
                            'start': i,
                            'end': i + chunk_size
                        })
                    except sr.UnknownValueError:
                        continue
                    except Exception as e:
                        print(f"Erro no chunk {i}-{i+chunk_size}s: {str(e)}")
                        continue
        
        except Exception as e:
            print(f"Erro ao gerar legendas: {str(e)}")
            traceback.print_exc()
        
        finally:
            # Limpeza segura do arquivo temporário
            if audio_path and os.path.exists(audio_path):
                try:
                    os.remove(audio_path)
                except Exception as e:
                    print(f"Erro ao remover arquivo temporário: {str(e)}")
        
        return subtitles