import json
import os
import time  # Adicionado para medir tempo total

from src.face_detector import FaceDetector
from src.subtitle_generator import SubtitleGenerator
from src.utils import format_time
from src.video_processor import VideoProcessor


class VideoEditor:
    def __init__(self, video_path):
        self.video_path = video_path
        self.output_path = self._generate_output_path()
        self.editing_params = {
            'subtitles': True,
            'subtitles_lang': 'pt',
            'auto_cuts': True,
            'include_timestamps': False,
            'background_music': None,
            'zoom_faces': True,
            'target_aspect_ratio': (9, 16)  # Vertical aspect ratio
        }
        
    def _generate_output_path(self):
        base, ext = os.path.splitext(self.video_path)
        return f"{base}_edited{ext}"
    
    def configure_editing(self):
        print("\n=== Configuração de Edição ===")
        
        # Legendas
        self.editing_params['subtitles'] = input("Incluir legendas? (s/n): ").lower() == 's'
        if self.editing_params['subtitles']:
            self.editing_params['subtitles_lang'] = input("Idioma das legendas (pt/en/es): ").lower()
        
        # Cortes automáticos
        self.editing_params['auto_cuts'] = input("Identificar cortes automaticamente? (s/n): ").lower() == 's'
        
        # Minutagens
        self.editing_params['include_timestamps'] = input("Incluir minutagens? (s/n): ").lower() == 's'
        
        # Música de fundo
        music_choice = input("Adicionar música ambiente de fundo? (s/n): ").lower()
        if music_choice == 's':
            self.editing_params['background_music'] = input("Caminho para o arquivo de música: ")
        
        # Zoom em rostos
        self.editing_params['zoom_faces'] = input("Ativar zoom dinâmico em rostos? (s/n): ").lower() == 's'
        
        print("\nConfiguração concluída!")
    
    def process_video(self):
        print("\nProcessando vídeo...")
        start_time = time.time()
        processor = VideoProcessor(self.video_path, self.output_path)
        
        # Gerar legendas se necessário
        if self.editing_params['subtitles']:
            print("Gerando legendas...")
            subtitle_gen = SubtitleGenerator(self.video_path, self.editing_params['subtitles_lang'])
            subtitles = subtitle_gen.generate()
            processor.add_subtitles(subtitles)
        
        # Detecção de rostos e zoom dinâmico
        if self.editing_params['zoom_faces']:
            print("Analisando rostos...")
            face_detector = FaceDetector(self.video_path)
            face_data = face_detector.analyze()
            processor.apply_face_zoom(face_data)
        
        # Processar cortes automáticos
        if self.editing_params['auto_cuts']:
            print("Identificando cortes...")
            cuts = processor.identify_cuts()
            processor.apply_cuts(cuts)
        
        # Adicionar música de fundo
        if self.editing_params['background_music']:
            print("Adicionando música de fundo...")
            processor.add_background_music(self.editing_params['background_music'])
        
        # Aplicar aspect ratio vertical
        processor.convert_to_vertical()
        
        # Renderizar vídeo final
        print("Renderizando vídeo final...")
        processor.render()
        elapsed = time.time() - start_time
        print(f"\nVídeo processado com sucesso! Salvo em: {self.output_path}")
        print(f"Tempo total de processamento: {elapsed:.2f} segundos")