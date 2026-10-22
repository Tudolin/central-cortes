import os
import time  # Adicionado para medir tempo
from collections import defaultdict

import cv2
import moviepy.config as mpy_config  # Adicionado para configurar ImageMagick
import moviepy.video.fx.all as vfx
import numpy as np
from moviepy.audio.AudioClip import CompositeAudioClip
from moviepy.editor import (AudioFileClip, CompositeVideoClip, TextClip,
                            VideoFileClip, concatenate_videoclips)


class VideoProcessor:
    def __init__(self, input_path, output_path):
        self.input_path = input_path
        self.output_path = output_path
        self.clip = VideoFileClip(input_path)
        
    def add_subtitles(self, subtitles):
        # Configuração do ImageMagick
        imagemagick_path = os.environ.get("IMAGEMAGICK_BINARY", r"C:\Program Files\ImageMagick-7.1.1-Q16-HDRI\magick.exe")
        if os.path.exists(imagemagick_path):
            mpy_config.change_settings({"IMAGEMAGICK_BINARY": imagemagick_path})
        
        # Calcula dimensões seguras para legendas no formato vertical
        video_width, video_height = self.clip.size
        safe_width = int(video_width * 0.9)  # 90% da largura
        safe_bottom = int(video_height * 0.85)  # 15% da base
        
        txt_clips = []
        for sub in subtitles:
            # Cria o TextClip com quebra automática de linha
            txt_clip = (TextClip(
                sub['text'],
                fontsize=36,  # Tamanho reduzido para mobile
                color='white',
                font='Arial-Bold',
                stroke_color='black',
                stroke_width=1.5,
                size=(safe_width, None),  # Largura máxima com altura automática
                method='caption'  # Quebra de linha automática
            )
            .set_start(sub['start'])
            .set_duration(sub['end'] - sub['start'])
            .set_position(('center', safe_bottom), relative=False))  # Posição absoluta
            
            txt_clips.append(txt_clip)
        
        self.clip = CompositeVideoClip([self.clip] + txt_clips)
    
    def apply_face_zoom(self, face_data):
        min_face_area = 5000  # área mínima para considerar um rosto real

        # Filtra apenas rostos significativos
        significant_faces = {t: [f for f in faces if f['size'] > min_face_area] 
                             for t, faces in face_data.items() if faces}

        # Encontra o rosto principal (que aparece por mais tempo)
        from collections import defaultdict
        face_durations = defaultdict(float)
        for t, faces in significant_faces.items():
            if faces:
                main_face = max(faces, key=lambda f: f['size'])
                face_id = (main_face['x'], main_face['y'])
                face_durations[face_id] += 0.1  # Assumindo análise a cada 0.1s

        if not face_durations:
            return  # Nenhum rosto significativo encontrado

        main_face_id = max(face_durations.keys(), key=lambda x: face_durations[x])

        def make_frame(get_frame, t):
            frame = get_frame(t)
            h, w = frame.shape[:2]
            target_ratio = 9/16
            crop_h = h
            crop_w = int(h * target_ratio)
            if crop_w > w:
                crop_w = w

            # Encontra o rosto principal no frame atual
            current_faces = significant_faces.get(t, [])
            current_main_face = None
            if current_faces:
                for face in current_faces:
                    if (face['x'], face['y']) == main_face_id:
                        current_main_face = face
                        break
                if not current_main_face:
                    current_main_face = max(current_faces, key=lambda f: f['size'])

            # Centraliza no rosto principal ou no centro do frame
            if current_main_face:
                x_center = int(current_main_face['x'])
            else:
                x_center = w // 2

            # Calcula limites do crop centralizado no rosto
            x1 = max(0, x_center - crop_w // 2)
            x2 = min(w, x_center + crop_w // 2)
            y1 = 0
            y2 = h
            cropped_frame = frame[y1:y2, x1:x2]
            final_frame = cv2.resize(cropped_frame, (crop_w, crop_h))
            return final_frame

        self.clip = self.clip.fl(make_frame)
    
    def identify_cuts(self):
        cuts = []
        threshold = 0.3
        prev_frame = None
        
        for t in np.arange(0, self.clip.duration, 0.1):
            frame = self.clip.get_frame(t)
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            
            if prev_frame is not None:
                diff = cv2.absdiff(gray, prev_frame)
                diff_mean = diff.mean() / 255
                
                if diff_mean > threshold:
                    cuts.append(t)
            
            prev_frame = gray
        
        return cuts
    
    def apply_cuts(self, cuts):
        if not cuts:
            return
            
        segments = []
        start = 0
        
        for cut in cuts:
            segments.append(self.clip.subclip(start, cut))
            start = cut
        
        segments.append(self.clip.subclip(start, self.clip.duration))
        self.clip = concatenate_videoclips(segments)
    
    def add_background_music(self, music_path):
        audio_clip = AudioFileClip(music_path).volumex(0.3)
        
        if audio_clip.duration < self.clip.duration:
            audio_clip = audio_clip.loop(duration=self.clip.duration)
        
        final_audio = CompositeAudioClip([
            self.clip.audio.volumex(0.7).set_duration(self.clip.duration),
            audio_clip
        ])
        
        self.clip = self.clip.set_audio(final_audio)
    
    def convert_to_vertical(self):
        w, h = self.clip.size
        target_ratio = 9/16
        
        if w/h > target_ratio:
            new_w = h * target_ratio
            self.clip = vfx.crop(self.clip, 
                               x1=(w - new_w)/2, 
                               width=new_w, 
                               y1=0, 
                               height=h)
        else:
            new_h = w / target_ratio
            self.clip = vfx.crop(self.clip, 
                               x1=0, 
                               width=w, 
                               y1=(h - new_h)/2, 
                               height=new_h)
    
    def render(self):
        self.clip = vfx.resize(self.clip, height=1080)
        print("Renderizando vídeo final...")
        start_time = time.time()
        self.clip.write_videofile(
            self.output_path,
            codec='libx264',
            audio_codec='aac',
            fps=30,
            threads=4,
            preset='fast',
            bitrate='2500k',  # Reduzido para otimizar tamanho
            ffmpeg_params=["-crf", "23"]  # Parâmetro correto para controle de qualidade
        )
        elapsed = time.time() - start_time
        print(f"Tempo de renderização: {elapsed:.2f} segundos")