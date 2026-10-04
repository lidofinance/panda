"""Install the self-contained KZG reconstruction regression and its real-client fixture."""
from pathlib import Path
import shutil


def apply(root):
    root = Path(root)
    here = Path(__file__).resolve().parent
    tests = root / 'beacon_node/beacon_chain/tests'
    fixtures = tests / 'fixtures'
    fixtures.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(here / 'native/reconstruction_test.rs', tests / 'panda_reconstruction.rs')
    shutil.copyfile(here / 'native/blob_checkpoint_fixture.json',
                    fixtures / 'panda_blob_checkpoint.json')
    with (root / 'beacon_node/beacon_chain/Cargo.toml').open('a') as target:
        target.write('\n[[test]]\nname = "panda_reconstruction"\n'
                     'path = "tests/panda_reconstruction.rs"\n')
