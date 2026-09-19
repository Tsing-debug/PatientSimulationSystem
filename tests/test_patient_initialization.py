import asyncio
import json
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from front import server
from fastapi.testclient import TestClient


def test_initialization_failure_does_not_publish_success(tmp_path, monkeypatch):
    path = tmp_path / 'initializations.json'
    monkeypatch.setattr(server, 'PATIENT_INITIALIZATIONS_FILE', path)
    monkeypatch.setattr(server, 'load_study_catalog', lambda: [{'stem': 'new', 'label': 'New trial'}])
    monkeypatch.setattr(server, '_ensure_study_assets', AsyncMock(side_effect=RuntimeError('HTTP 429')))
    with pytest.raises(HTTPException) as error:
        asyncio.run(server.admin_initialize_patients(server.PatientInitializationBody(trials=['New trial']), {'role': 'admin'}))
    assert error.value.status_code == 503
    assert not path.exists()


def test_initialization_waits_for_assets_and_saves_language(tmp_path, monkeypatch):
    path = tmp_path / 'initializations.json'
    monkeypatch.setattr(server, 'PATIENT_INITIALIZATIONS_FILE', path)
    monkeypatch.setattr(server, 'load_study_catalog', lambda: [{'stem': 'new', 'label': 'New trial'}])
    ensure = AsyncMock()
    monkeypatch.setattr(server, '_ensure_study_assets', ensure)
    result = asyncio.run(server.admin_initialize_patients(server.PatientInitializationBody(trials=['New trial'], language='en'), {'role': 'admin'}))
    ensure.assert_awaited_once_with('new')
    assert result['versions']['New trial'] == 1
    assert result['active_stems'] == ['new']
    assert json.loads(path.read_text())['languages']['New trial'] == 'en'


def test_three_roles_share_deletion_and_reinitialization(tmp_path, monkeypatch):
    monkeypatch.setattr(server, 'PATIENT_INITIALIZATIONS_FILE', tmp_path / 'state.json')
    monkeypatch.setattr(server, 'load_study_catalog', lambda: [{'stem': 'new', 'label': 'New trial'}])
    monkeypatch.setattr(server, '_ensure_study_assets', AsyncMock())
    def studies():
        state = server._load_patient_initializations()
        return [{'stem': 'new', 'label': 'New trial', 'ready': True,
                 'patient_card_deleted': 'new' in state.get('deleted_stems', [])}]
    monkeypatch.setattr(server, '_list_ready_studies', studies)
    monkeypatch.setattr(server.account_store, 'user_by_token', lambda token: {'role': token, 'username': token} if token in ('admin', 'staff', 'student') else None)
    with TestClient(server.app) as client:
        headers = lambda role: {'Authorization': f'Bearer {role}'}
        for role in ('staff', 'student'):
            assert client.delete('/api/admin/patient-cards/new', headers=headers(role)).status_code == 403
        assert client.delete('/api/admin/patient-cards/new', headers=headers('admin')).status_code == 200
        snapshots = [client.get('/api/patient-catalog', headers=headers(role)).json() for role in ('admin', 'staff', 'student')]
        assert snapshots[0] == snapshots[1] == snapshots[2]
        assert snapshots[0]['studies'][0]['patient_card_deleted']
        response = client.post('/api/admin/patient-initializations', headers=headers('admin'), json={'trials': ['New trial'], 'language': 'en'})
        assert response.status_code == 200
        snapshots = [client.get('/api/patient-catalog', headers=headers(role)).json() for role in ('admin', 'staff', 'student')]
        assert snapshots[0] == snapshots[1] == snapshots[2]
        assert not snapshots[0]['studies'][0]['patient_card_deleted']
        assert snapshots[0]['languages']['New trial'] == 'en'


def test_personal_regeneration_is_private_and_admin_override_wins(tmp_path, monkeypatch):
    path = tmp_path / 'state.json'
    path.write_text(json.dumps({
        'versions': {'New trial': 1},
        'languages': {'New trial': 'zh'},
        'active_stems': ['new'],
        'deleted_stems': [],
        'user_initializations': {},
    }), encoding='utf-8')
    monkeypatch.setattr(server, 'PATIENT_INITIALIZATIONS_FILE', path)
    monkeypatch.setattr(server, 'load_study_catalog', lambda: [{'stem': 'new', 'label': 'New trial'}])
    monkeypatch.setattr(server, '_list_ready_studies', lambda: [{'stem': 'new', 'label': 'New trial', 'ready': True}])
    monkeypatch.setattr(server, '_ensure_study_assets', AsyncMock())
    monkeypatch.setattr(server.account_store, 'user_by_token', lambda token: {'role': 'admin' if token == 'admin' else 'student', 'username': token})
    with TestClient(server.app) as client:
        headers = lambda user: {'Authorization': f'Bearer {user}'}
        assert client.post('/api/patient-catalog/regenerate', headers=headers('student-a'), json={'stems': ['new']}).status_code == 200
        mine = client.get('/api/patient-catalog', headers=headers('student-a')).json()
        other = client.get('/api/patient-catalog', headers=headers('student-b')).json()
        assert mine['studies'][0]['personal_seed'] is not None
        assert other['studies'][0]['personal_seed'] is None

        response = client.post('/api/admin/patient-initializations', headers=headers('admin'), json={'trials': ['New trial'], 'language': 'en'})
        assert response.status_code == 200
        after_override = client.get('/api/patient-catalog', headers=headers('student-a')).json()
        assert after_override['studies'][0]['personal_seed'] is None
        assert after_override['languages']['New trial'] == 'en'
