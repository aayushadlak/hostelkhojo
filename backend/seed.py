from .database import engine, Base, SessionLocal
from .models import HostelDB, RoommateDB, UserDB

def seed_database():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        # Purge ALL roommate requirements and dummy hostels/accounts
        db.query(RoommateDB).delete(synchronize_session=False)
        db.query(HostelDB).filter(HostelDB.id.in_(["h_1", "h_2", "h_3"])).delete(synchronize_session=False)
        db.query(UserDB).filter((UserDB.id == "usr_demo_1") | (UserDB.email == "student@hostelkhojo.in")).delete(synchronize_session=False)

        db.commit()
        print("Database initialized cleanly: Purged all roommate requirements, dummy hostels, and demo accounts.")
    except Exception as e:
        db.rollback()
        print(f"Database cleanup status: {e}")
    finally:
        db.close()

if __name__ == "__main__":
    seed_database()
