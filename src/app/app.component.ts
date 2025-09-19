import { HttpClient } from '@angular/common/http';
import { Component, HostListener, OnDestroy, signal } from '@angular/core';
import { FormControl, FormGroup, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import {
    createLocalScreenTracks,
    LocalTrack,
    LocalVideoTrack,
    RemoteParticipant,
    RemoteTrack,
    RemoteTrackPublication,
    Room,
    RoomEvent,
    Track,
} from 'livekit-client';
import { lastValueFrom } from 'rxjs';
import { AudioComponent } from './audio/audio.component';
import { VideoComponent } from './video/video.component';

type TrackInfo = {
    trackPublication: RemoteTrackPublication;
    participantIdentity: string;
};

// Để trống khi chạy OpenVidu Local; component sẽ tự suy ra URL mặc định
let APPLICATION_SERVER_URL = '';
let LIVEKIT_URL = '';

@Component({
    selector: 'app-root',
    standalone: true,
    imports: [ReactiveFormsModule, AudioComponent, FormsModule, VideoComponent],
    templateUrl: './app.component.html',
    styleUrl: './app.component.css',
})
export class AppComponent implements OnDestroy {
    roomForm = new FormGroup({
        roomName: new FormControl('Test Room', Validators.required),
        participantName: new FormControl('Participant' + Math.floor(Math.random() * 100), Validators.required),
    });

    room = signal<Room | undefined>(undefined);
    remoteTracksMap = signal<Map<string, TrackInfo>>(new Map());
    participants = signal<string[]>([]);

    constructor(private httpClient: HttpClient) {
        this.configureUrls();
    }

    private configureUrls() {
        // Application server URL (Spring/Node) để cấp token
        if (!APPLICATION_SERVER_URL) {
            if (window.location.hostname === 'localhost') {
                APPLICATION_SERVER_URL = 'http://localhost:6080/';
            } else {
                APPLICATION_SERVER_URL = 'https://' + window.location.hostname + ':6443/';
            }
        }
        // LiveKit URL (WS/WSS)
        if (!LIVEKIT_URL) {
            if (window.location.hostname === 'localhost') {
                LIVEKIT_URL = 'ws://localhost:7880/';
            } else {
                LIVEKIT_URL = 'wss://' + window.location.hostname + ':7881';
            }
        }
    }

    messages = signal<{ from: string; text: string }[]>([]);
    chatInput = '';
    async joinRoom() {
        const room = new Room();
        this.room.set(room);

        // === sự kiện nhận tin nhắn ===
        room.on(RoomEvent.DataReceived, (payload, participant, kind, topic) => {
            const text = new TextDecoder().decode(payload);
            const from = participant?.name || participant?.identity || 'Unknown';
            this.messages.update((list) => [...list, { from, text }]);
        });

        // Nhận track remote (chỉ quan tâm audio)
        room.on(
            RoomEvent.TrackSubscribed,
            (_track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
                // audio
                if (publication.kind === 'audio') {
                    this.remoteTracksMap.update((map) => {
                        map.set(publication.trackSid, {
                            trackPublication: publication,
                            participantIdentity: participant.identity,
                        });
                        return map;
                    });
                }
                // video screen share
                if (publication.kind === 'video' && publication.source === Track.Source.ScreenShare) {
                    this.remoteTracksMap.update((map) => {
                        map.set(publication.trackSid, {
                            trackPublication: publication,
                            participantIdentity: participant.identity,
                        });
                        return map;
                    });
                }
            }
        );

        room.on(RoomEvent.TrackUnsubscribed, (_track: RemoteTrack, publication: RemoteTrackPublication) => {
            this.remoteTracksMap.update((map) => {
                map.delete(publication.trackSid);
                return map;
            });
        });

        // Cập nhật danh sách người tham gia
        room.on(RoomEvent.ParticipantConnected, (p) => {
            this.participants.update((list) => Array.from(new Set([...list, p.name || p.identity])));
        });
        room.on(RoomEvent.ParticipantDisconnected, (p) => {
            const id = p.name || p.identity;
            this.participants.update((list) => list.filter((x) => x !== id));
        });
        room.on(RoomEvent.ParticipantNameChanged, (name, p) => {
            const id = p.identity;
            this.participants.update((list) => {
                const next = list.slice();
                const idx = next.findIndex((x) => x === id || x === (p.name || id));
                if (idx !== -1) next[idx] = name || id;
                return next;
            });
        });

        try {
            const roomName = this.roomForm.value.roomName!;
            const participantName = this.roomForm.value.participantName!;

            // Lấy token từ backend
            const token = await this.getToken(roomName, participantName);

            // Kết nối vào LiveKit
            await room.connect(LIVEKIT_URL, token);

            // Danh sách ban đầu: tất cả remote + chính mình
            const existing = Array.from(room.remoteParticipants.values()).map((p) => p.name || p.identity);
            this.participants.set([participantName, ...existing]);

            // Audio-only: tắt camera, bật mic
            await room.localParticipant.setCameraEnabled(false);
            await room.localParticipant.setMicrophoneEnabled(true);
        } catch (error: any) {
            console.log('Error connecting:', error?.error?.errorMessage || error?.message || error);
            await this.leaveRoom();
        }
    }

    async sendMessage() {
        if (!this.chatInput.trim() || !this.room()) return;

        const msg = this.chatInput.trim();
        const data = new TextEncoder().encode(msg);

        // gửi tin nhắn lên tất cả mọi người trong phòng
        await this.room()!.localParticipant.publishData(data, {
            reliable: true, // tương đương DataPacket_Kind.RELIABLE
        });

        // thêm vào danh sách tin nhắn local
        this.messages.update((list) => [...list, { from: 'Me', text: msg }]);
        this.chatInput = '';
    }

    async leaveRoom() {
        if (this.isScreenSharing) {
            await this.stopScreenShare();
        }
        await this.room()?.disconnect();
        this.room.set(undefined);
        this.remoteTracksMap.set(new Map());
        this.participants.set([]);
    }

    @HostListener('window:beforeunload')
    async ngOnDestroy() {
        await this.leaveRoom();
    }

    // ---- Lấy token từ Application Server ----
    private async getToken(roomName: string, participantName: string): Promise<string> {
        const res = await lastValueFrom(
            this.httpClient.post<{ token: string }>(APPLICATION_SERVER_URL + 'token', { roomName, participantName })
        );
        return res.token;
    }

    isScreenSharing = false;
    private screenShareTracks: LocalTrack[] = [];

    async toggleScreenShare() {
        const r = this.room();
        if (!r) return;

        try {
            if (!this.isScreenSharing) {
                const tracks = await createLocalScreenTracks({
                    audio: true, // nếu browser hỗ trợ
                });

                this.screenShareTracks = tracks as LocalTrack[];

                for (const t of this.screenShareTracks) {
                    await r.localParticipant.publishTrack(t);

                    // Khi user bấm Stop share trên UI trình duyệt
                    const mst = (t as LocalVideoTrack).mediaStreamTrack ?? (t as any).mediaStreamTrack;
                    if (mst) {
                        mst.addEventListener(
                            'ended',
                            async () => {
                                await this.stopScreenShare();
                            },
                            { once: true }
                        );
                    }
                }

                this.isScreenSharing = true;
            } else {
                await this.stopScreenShare();
            }
        } catch (e) {
            console.error('Screen share error', e);
        }
    }

    private async stopScreenShare() {
        const r = this.room();
        if (!r) return;

        for (const t of this.screenShareTracks) {
            try {
                r.localParticipant.unpublishTrack(t, true);
                t.stop();
            } catch {}
        }

        this.screenShareTracks = [];
        this.isScreenSharing = false;
    }
}
