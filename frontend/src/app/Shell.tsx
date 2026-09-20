import { Outlet } from '@tanstack/react-router';
import classes from './Shell.module.css';

export function Shell() {
    return <main className={classes.main}><Outlet /></main>;
}
