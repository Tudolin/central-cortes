from collections import defaultdict

import cv2


class FaceDetector:
    def __init__(self, video_path):
        self.video_path = video_path
        # Usando o detector de faces do OpenCV
        self.face_cascade = cv2.CascadeClassifier(
            cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
        )
        
    def analyze(self):
        cap = cv2.VideoCapture(self.video_path)
        fps = cap.get(cv2.CAP_PROP_FPS)
        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        
        face_data = defaultdict(list)
        
        # Usa um detector mais moderno se disponível
        try:
            detector = cv2.FaceDetectorYN.create(
                "face_detection_yunet_2023mar.onnx",
                "",
                (320, 320),
                0.9,  # Score threshold
                0.3,  # NMS threshold
                5000  # Top K
            )
            use_modern_detector = True
        except:
            use_modern_detector = False
        
        for i in range(frame_count):
            ret, frame = cap.read()
            if not ret:
                continue
                
            t = i / fps
            if use_modern_detector:
                # Redimensiona frame para (320, 320)
                h_orig, w_orig = frame.shape[:2]
                frame_resized = cv2.resize(frame, (320, 320))
                detector.setInputSize((320, 320))
                retval, faces = detector.detect(frame_resized)
                if faces is not None and len(faces) > 0:
                    for face in faces:
                        x, y, w, h = face[:4]
                        # Ajusta coordenadas para o tamanho original
                        x = x * w_orig / 320
                        y = y * h_orig / 320
                        w = w * w_orig / 320
                        h = h * h_orig / 320
                        face_data[t].append({
                            'x': x + w/2,
                            'y': y + h/2,
                            'size': w * h
                        })
            else:
                # Fallback para Haar Cascade
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                faces = self.face_cascade.detectMultiScale(gray, 1.1, 4)
                for (x, y, w, h) in faces:
                    face_data[t].append({
                        'x': x + w/2,
                        'y': y + h/2,
                        'size': w * h
                    })
        
        cap.release()
        return face_data